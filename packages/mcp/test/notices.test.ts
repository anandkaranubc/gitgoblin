import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build helper without type declarations
import { collectPackages, writeNotices } from "../../../scripts/notices.mjs";

const root = mkdtempSync(join(tmpdir(), "gitgoblin-notices-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakePackage(name: string, license: string | undefined, files: Record<string, string>): void {
  const dir = join(root, "node_modules", name);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", ...(license ? { license } : {}) }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
}

fakePackage("tiny", "MIT", { LICENSE: "MIT License\nCopyright (c) Tiny Authors\n" });
fakePackage("@scope/big", "Apache-2.0", { "LICENSE.txt": "Apache License 2.0 text", NOTICE: "Big\nCopyright Big Corp" });
fakePackage("bare", undefined, {});
fakePackage("viral", "GPL-3.0-only", { COPYING: "GPL text" });

const inputs = (names: string[]) => ({
  inputs: Object.fromEntries([
    ...names.map((name) => [`node_modules/${name}/lib/index.js`, {}]),
    [`node_modules/${names[0]}/lib/other.js`, {}],
    ["src/own-code.ts", {}],
    ["../core/src/index.ts", {}],
  ]),
});

describe("notices", () => {
  it("groups inputs by package, skips workspace code, and reads every license file", () => {
    const packages = collectPackages(inputs(["tiny", "@scope/big"]), { root });
    expect(packages.map((p: { name: string }) => p.name)).toEqual(["@scope/big", "tiny"]);
    expect(packages[0].files.map((f: { name: string }) => f.name)).toEqual(["LICENSE.txt", "NOTICE"]);
  });

  it("writes license and notice text, and warns about a package with none", () => {
    const out = join(root, "NOTICES.md");
    const { warnings } = writeNotices(inputs(["tiny", "@scope/big", "bare"]), out, { root, product: "test-product" });
    const text = readFileSync(out, "utf8");
    expect(text).toContain("test-product bundles the following packages");
    expect(text).toContain("## tiny 1.2.3");
    expect(text).toContain("Copyright (c) Tiny Authors");
    expect(text).toContain("Copyright Big Corp");
    expect(warnings).toEqual(["bare 1.2.3: no license declared"]);
  });

  it("refuses a strong-copyleft dependency", () => {
    expect(() => writeNotices(inputs(["tiny", "viral"]), join(root, "never.md"), { root })).toThrow(/refusing to bundle viral \(GPL-3.0-only\)/);
  });

  it("ships the project's license and the notices with the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "dist/THIRD_PARTY_NOTICES.md"]));
    expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toBe(readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8"));
  });
});
