import { describe, expect, it } from "vitest";
import { readNodeManifest } from "../src/manifests/node.ts";
import { describeEcosystems } from "../src/profile/ecosystems.ts";
import { inventoryOf, reader } from "./helpers/inventory.ts";

async function nodeCommands(files: Record<string, string>, extra: string[] = []) {
  const inventory = inventoryOf([...Object.keys(files), ...extra]);
  const node = await readNodeManifest(inventory, reader(files));
  return describeEcosystems({ node, others: [] } as never, inventory, []).find((e) => e.name === "node")!.commands;
}

describe("node check commands", () => {
  it("runs a Bun project's scripts, not Bun's bundler and test runner (heygen-com/hyperframes)", async () => {
    const commands = await nodeCommands({
      "package.json": JSON.stringify({ private: true, scripts: { build: "bun run --filter '*' build", test: "bun run test:unit", lint: "oxlint", format: "oxfmt", "typecheck:scripts": "tsc -p scripts" }, devDependencies: { typescript: "5.9.3" } }),
    }, ["bun.lock"]);
    expect(commands).toMatchObject({ build: "bun run build", test: "bun run test", lint: "bun run lint", format: "bun run format" });
    // No root tsconfig.json and no root typecheck script: tsc would print its help and fail.
    expect(commands.typecheck).toBeUndefined();
  });

  it("derives tsc only when the root has a tsconfig.json, through the project's package runner", async () => {
    const pkg = JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { typescript: "5.9.3" } });
    expect((await nodeCommands({ "package.json": pkg, "tsconfig.json": "{}" }, ["package-lock.json"])).typecheck).toBe("npx tsc --noEmit");
    expect((await nodeCommands({ "package.json": pkg, "tsconfig.json": "{}" }, ["bun.lock"])).typecheck).toBe("bunx tsc --noEmit");
    expect((await nodeCommands({ "package.json": pkg, "tsconfig.base.json": "{}" }, ["package-lock.json"])).typecheck).toBeUndefined();
  });

  it("keeps npm's and pnpm's script forms", async () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc -b" } });
    expect(await nodeCommands({ "package.json": pkg }, ["package-lock.json"])).toMatchObject({ test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" });
    expect(await nodeCommands({ "package.json": pkg }, ["pnpm-lock.yaml"])).toMatchObject({ test: "pnpm run test", lint: "pnpm run lint", typecheck: "pnpm run typecheck" });
  });
});
