import { describe, expect, it } from "vitest";
import { AGENT_SDK, AGENT_SDK_HINT, importSibling, isNotInstalled, loadEngine, loadIntel } from "../src/siblings.ts";

describe("isNotInstalled", () => {
  it("is true only for a module-not-found error about the package itself", () => {
    const missing = Object.assign(new Error("Cannot find package '@gitgoblin/intel' imported from /x/index.ts"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isNotInstalled(missing, "@gitgoblin/intel")).toBe(true);
    // The package is there but one of its own imports is not: that is a broken install, not a missing one.
    const inner = Object.assign(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /x/agent.ts"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isNotInstalled(inner, "@gitgoblin/engine")).toBe(false);
    expect(isNotInstalled(new SyntaxError("Unexpected token"), "@gitgoblin/intel")).toBe(false);
    expect(isNotInstalled("nope", "@gitgoblin/intel")).toBe(false);
  });
});

describe("importSibling", () => {
  const notFound = (pkg: string, from: string) => Object.assign(new Error(`Cannot find package '${pkg}' imported from ${from}`), { code: "ERR_MODULE_NOT_FOUND" });

  it("returns the module, or undefined when the package itself is not installed", async () => {
    expect(await importSibling("@gitgoblin/intel", async () => ({ ok: true }))).toEqual({ ok: true });
    expect(
      await importSibling("@gitgoblin/intel", async () => {
        throw notFound("@gitgoblin/intel", "/x/dist/gitgoblin.mjs");
      }),
    ).toBeUndefined();
  });

  it("turns a missing Agent SDK under the engine into the one-line install hint", async () => {
    // What the npm bundle's engine chunk throws when only the SDK is absent.
    const load = async () => {
      throw notFound(AGENT_SDK, "/x/dist/chunks/engine-ABC123.mjs");
    };
    await expect(importSibling("@gitgoblin/engine", load)).rejects.toThrow(AGENT_SDK_HINT);
    expect(AGENT_SDK_HINT).toContain(`npm install -g gitgoblin ${AGENT_SDK}`);
  });

  it("surfaces every other load failure with its real first line", async () => {
    const broken = async () => {
      throw new SyntaxError("Unexpected token 'export'\n    at somewhere");
    };
    await expect(importSibling("@gitgoblin/engine", broken)).rejects.toThrow("@gitgoblin/engine is installed but failed to load: Unexpected token 'export'");
    // A different missing package under the engine is a broken install, not the SDK case.
    const other = async () => {
      throw notFound("zod", "/x/dist/chunks/engine-ABC123.mjs");
    };
    await expect(importSibling("@gitgoblin/engine", other)).rejects.toThrow(/is installed but failed to load: Cannot find package 'zod'/);
    // The SDK case belongs to the engine only.
    const sdkUnderIntel = async () => {
      throw notFound(AGENT_SDK, "/x/intel.mjs");
    };
    await expect(importSibling("@gitgoblin/intel", sdkUnderIntel)).rejects.toThrow(/is installed but failed to load/);
  });
});

describe("loadIntel and loadEngine", () => {
  it("accept the real packages", async () => {
    const load = async (name: string) => (await import(name)) as Record<string, unknown>;
    expect(await loadIntel(load)).toBeDefined();
    expect(await loadEngine(load)).toBeDefined();
  });

  it("reject a module missing any of the functions the CLI calls", async () => {
    expect(await loadIntel(async () => ({ analyzeRepository: () => {} }))).toBeUndefined();
    expect(await loadEngine(async () => ({ runContribution: () => {} }))).toBeUndefined();
    expect(await loadEngine(async () => undefined)).toBeUndefined();
  });
});
