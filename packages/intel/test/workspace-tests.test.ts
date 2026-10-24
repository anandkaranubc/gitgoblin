import { describe, expect, it } from "vitest";
import { readNodeManifest } from "../src/manifests/node.ts";
import { workspaceTestCommand } from "../src/profile/ecosystems.ts";
import { inventoryOf, reader } from "./helpers/inventory.ts";

describe("tests that live in workspace packages", () => {
  it("finds a workspace package's test script when the root has none (shoelace-style/webawesome)", async () => {
    const inventory = inventoryOf(["package.json", "package-lock.json", "packages/webawesome/package.json", "packages/docs/package.json", "node_modules/x/package.json"]);
    const m = await readNodeManifest(inventory, reader({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { build: "x" } }),
      "packages/webawesome/package.json": JSON.stringify({ name: "@awesome.me/webawesome", scripts: { test: "web-test-runner --group default" } }),
      "packages/docs/package.json": JSON.stringify({ name: "docs", scripts: { build: "eleventy" } }),
    }));
    expect(m?.workspaceTests).toEqual([{ dir: "packages/webawesome", name: "@awesome.me/webawesome", script: "web-test-runner --group default" }]);
    expect(m?.tooling).toContain("web-test-runner");
    expect(workspaceTestCommand("npm", m!.workspaceTests, inventory)).toBe("npm test -w packages/webawesome");
  });

  it("runs every workspace's tests through the package manager when several have them", () => {
    const two = [{ dir: "packages/a", name: "a", script: "vitest" }, { dir: "packages/b", name: "b", script: "jest" }];
    expect(workspaceTestCommand("npm", two, inventoryOf(["package.json"]))).toBe("npm test --workspaces --if-present");
    expect(workspaceTestCommand("pnpm", two, inventoryOf(["package.json"]))).toBe("pnpm -r --if-present test");
    expect(workspaceTestCommand("yarn", two, inventoryOf(["package.json", ".yarnrc.yml"]))).toBe("yarn workspaces foreach -A run test");
    expect(workspaceTestCommand("pnpm", [two[0]!], inventoryOf(["package.json"]))).toBe("pnpm --filter a test");
  });
});

describe("test gaps nobody can verify", () => {
  it("says so first when the repository has no detectable test command", async () => {
    const { testGapsAnalyzer } = await import("../src/analyzers/test-gaps.ts");
    const inventory = inventoryOf(["src/a.ts", "test/a.test.ts"]);
    const files: Record<string, string> = { "test/a.test.ts": 'it.skip("parses dates", () => {});\n', "src/a.ts": "export const a = 1;\n" };
    const ctx = { inventory, read: async (p: string) => files[p], commits: [], repo: { grep: async () => [] }, budget: { note() {}, cut() {} }, meta: { name: "r", description: "" }, nowIso: "2026-10-23T00:00:00Z" } as never;
    const profile = { nature: "library", ecosystems: [{ name: "node", commands: {} }], structure: { testDirs: ["test"], centralFiles: [] }, conventions: {}, hotFiles: [] } as never;
    const findings = await testGapsAnalyzer.run(ctx, profile);
    const skipped = findings.find((f) => f.title.startsWith("Investigate and re-enable"));
    expect(skipped?.risks?.[0]).toMatch(/^No test command was detected/);
    const withCommand = await testGapsAnalyzer.run(ctx, { ...(profile as object), ecosystems: [{ name: "node", commands: { test: "npm test" } }] } as never);
    expect(withCommand.find((f) => f.title.startsWith("Investigate and re-enable"))?.risks?.[0]).not.toMatch(/No test command/);
  });
});
