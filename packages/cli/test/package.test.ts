import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Runtime, run } from "../src/index.ts";
import { AGENT_SDK } from "../src/siblings.ts";

const here = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files: string[];
};

describe("the published package", () => {
  it("reports the version in package.json", async () => {
    const out: string[] = [];
    const runtime = { stdout: (t: string) => out.push(t), stderr: () => {} } as unknown as Runtime;
    expect(await run(["--version"], runtime)).toBe(0);
    expect(out.join("").trim()).toBe(manifest.version);
  });

  it("depends on nothing at run time except the optional Agent SDK", () => {
    // The @gitgoblin siblings are not on npm; a dependency on one would make the install fail.
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([AGENT_SDK]);
    expect(manifest.peerDependenciesMeta?.[AGENT_SDK]?.optional).toBe(true);
  });

  it("carries the repository's license", () => {
    expect(readFileSync(join(here, "LICENSE"), "utf8")).toBe(readFileSync(join(here, "../../LICENSE"), "utf8"));
    expect(manifest.files).toEqual(expect.arrayContaining(["bin", "dist", "LICENSE", "README.md"]));
  });
});

describe("the bundle", () => {
  let copy: string;

  beforeAll(() => {
    execFileSync(process.execPath, [join(here, "scripts/bundle.mjs")], { stdio: "pipe" });
    // Outside the repository, so nothing can resolve from the workspace's node_modules.
    copy = mkdtempSync(join(tmpdir(), "gitgoblin-bundle-"));
    cpSync(join(here, "dist"), copy, { recursive: true });
  }, 60_000);
  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  it("runs the commands that need no network with no node_modules at all", () => {
    const goals = execFileSync(process.execPath, [join(copy, "gitgoblin.mjs"), "goals"], { encoding: "utf8" });
    expect(goals).toContain("contribute");
    expect(execFileSync(process.execPath, [join(copy, "gitgoblin.mjs"), "--version"], { encoding: "utf8" }).trim()).toBe(manifest.version);
  });

  it("imports the Agent SDK only from the engine's own chunk, and ships the notices", () => {
    // The entry names the SDK in its install hint, so look for an import statement, not the string.
    const imports = (file: string) => new RegExp(`^import .* from "${AGENT_SDK}";$`, "m").test(readFileSync(file, "utf8"));
    expect(imports(join(copy, "gitgoblin.mjs"))).toBe(false);
    const chunks = readdirSync(join(copy, "chunks")).filter((name) => imports(join(copy, "chunks", name)));
    expect(chunks).toHaveLength(1);
    expect(readFileSync(join(copy, "THIRD_PARTY_NOTICES.md"), "utf8")).toMatch(/## zod /);
  });
});
