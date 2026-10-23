import { describe, expect, it } from "vitest";
import { isNotInstalled, loadEngine, loadIntel } from "../src/siblings.ts";

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
