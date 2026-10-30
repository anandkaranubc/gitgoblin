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

  it("keeps a library a library when its description says learning, examples or samples", () => {
    const inventory = inventoryOf(["pyproject.toml", ...Array.from({ length: 120 }, (_, i) => `stable_baselines3/m${i}.py`)]);
    const python: Manifests = { others: [], python: { paths: ["pyproject.toml"], name: "stable-baselines3", requiresPython: ">=3.9", classifierVersions: [], dependencies: [], scripts: [], packageManager: "pip", tooling: [], packageDirs: ["stable_baselines3"], hasPyTyped: false, extras: [], dependencyGroups: [] } };
    for (const description of ["PyTorch version of Stable Baselines, reliable implementations of reinforcement learning algorithms.", "A python library for self-supervised learning on images.", "Fast resampling of audio samples", "Config parsing, with examples"]) {
      expect(classifyNature({ meta: meta({ name: "stable-baselines3", description }), inventory, manifests: python, readme: "" }).nature, description).toBe("library");
    }
  });

  it("still calls tutorials and example repositories tutorials", () => {
    const go: Manifests = { others: [], go: { paths: ["go.mod"], module: "golang.org/x/example", goVersion: "1.22", dependencies: [], hasMainPackage: true, tooling: [] } };
    expect(classifyNature({ meta: meta({ name: "example", description: "Go example projects" }), inventory: inventoryOf(["go.mod", "hello/hello.go"]), manifests: go, readme: "" }).nature).toBe("tutorial");
    expect(classifyNature({ meta: meta({ name: "functions-quickstart", description: "Sample code for a serverless function" }), inventory: inventoryOf(["index.js", "README.md"]), manifests: none, readme: "" }).nature).toBe("tutorial");
    const privateApp: Manifests = { others: [], node: { paths: ["package.json"], name: "shop-demo", private: true, hasBin: false, hasMainOrExports: false, engines: undefined, scripts: {}, dependencies: [], packageManager: "npm", tooling: [], workspaces: false, workspaceTests: [] } };
    expect(classifyNature({ meta: meta({ name: "shop-demo", description: "Workshop: build a web shop step by step" }), inventory: inventoryOf(["package.json", "src/app.js"]), manifests: privateApp, readme: "" }).nature).toBe("tutorial");
  });

  it("falls back to unknown with a reason", () => {
    const r = classifyNature({ meta: meta(), inventory: inventoryOf(["foo.c", "bar.c", "baz.h"]), manifests: none, readme: "" });
    expect(r.nature).toBe("unknown");
    expect(r.reason.length).toBeGreaterThan(5);
  });
});
