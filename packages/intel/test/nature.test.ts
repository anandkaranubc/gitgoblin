import { describe, expect, it } from "vitest";
import type { Manifests } from "../src/manifests/index.ts";
import { classifyNature } from "../src/profile/nature.ts";
import { inventoryOf } from "./helpers/inventory.ts";

const none: Manifests = { others: [] };
const meta = (over: Partial<{ name: string; description: string; topics: string[]; isTemplate: boolean }> = {}) => ({
  name: "thing", description: "", topics: [], isTemplate: false, ...over,
});

describe("classifyNature", () => {
  it("spots awesome lists, dotfiles and templates by name", () => {
    expect(classifyNature({ meta: meta({ name: "awesome-go" }), inventory: inventoryOf(["README.md"]), manifests: none, readme: "" }).nature).toBe("awesome_list");
    expect(classifyNature({ meta: meta({ name: "dotfiles" }), inventory: inventoryOf([".zshrc"]), manifests: none, readme: "" }).nature).toBe("config");
    expect(classifyNature({ meta: meta({ isTemplate: true }), inventory: inventoryOf(["README.md"]), manifests: none, readme: "" }).nature).toBe("template");
  });

  it("calls a repo of markdown files docs, and one with a citation research", () => {
    const docsInv = inventoryOf(["README.md", "docs/a.md", "docs/b.md", "docs/c.md", "LICENSE"]);
    expect(classifyNature({ meta: meta(), inventory: docsInv, manifests: none, readme: "" }).nature).toBe("docs");
    const research = inventoryOf(["README.md", "CITATION.cff", "train.py", "model.py"]);
    expect(classifyNature({ meta: meta(), inventory: research, manifests: none, readme: "" }).nature).toBe("research");
  });

  it("uses manifests to tell libraries, CLIs and applications apart", () => {
    const base = inventoryOf(["package.json", "src/index.ts"]);
    const node = (over: Partial<NonNullable<Manifests["node"]>>): Manifests => ({
      others: [],
      node: { paths: ["package.json"], name: "x", private: false, hasBin: false, hasMainOrExports: true, engines: undefined, scripts: {}, dependencies: [], packageManager: "npm", tooling: [], workspaces: false, workspaceTests: [], ...over },
    });
    expect(classifyNature({ meta: meta(), inventory: base, manifests: node({}), readme: "" }).nature).toBe("library");
    expect(classifyNature({ meta: meta(), inventory: base, manifests: node({ hasBin: true, hasMainOrExports: false }), readme: "" }).nature).toBe("cli");
    expect(classifyNature({ meta: meta(), inventory: base, manifests: node({ private: true, dependencies: [{ name: "next", version: "14", pinned: false, dev: false }] }), readme: "" })).toMatchObject({ nature: "application", reason: expect.stringContaining("next") });
    const go: Manifests = { others: [], go: { paths: ["go.mod"], module: "m", goVersion: "1.22", dependencies: [], hasMainPackage: true, tooling: [] } };
    expect(classifyNature({ meta: meta(), inventory: inventoryOf(["go.mod", "main.go"]), manifests: go, readme: "" }).nature).toBe("cli");
  });

  it("falls back to unknown with a reason", () => {
    const r = classifyNature({ meta: meta(), inventory: inventoryOf(["foo.c", "bar.c", "baz.h"]), manifests: none, readme: "" });
    expect(r.nature).toBe("unknown");
    expect(r.reason.length).toBeGreaterThan(5);
  });
});
