/**
 * Opt-in end-to-end run with the real Claude Agent SDK. Costs money and takes minutes:
 *   GITGOBLIN_LIVE=1 npx vitest run test/live.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { scrubEnv } from "../src/guard.ts";
import { consoleReporter } from "../src/journal.ts";
import { runContribution } from "../src/orchestrator.ts";
import { git } from "../src/workspace.ts";
import { createFixtureRepo, env, FIXED, fixtureTask } from "./helpers/fixture.ts";

const live = process.env["GITGOBLIN_LIVE"] === "1";

(live ? it : it.skip)("fixes the fixture bug with a real model, sandboxed", { timeout: 20 * 60_000 }, async () => {
  const repo = await createFixtureRepo();
  const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-live-"));
  const result = await runContribution(
    { task: fixtureTask(repo) },
    { workdir, env: { ...scrubEnv(), ...env }, reporter: consoleReporter(), limits: { maxCostUsd: 5 } },
  );
  process.stderr.write(`\n${readFileSync(path.join(result.runDir, "report.md"), "utf8")}\n`);

  expect(result.status).toBe("awaiting_approval");
  const ws = result.workspace!;
  expect(readFileSync(path.join(ws, "src", "paginate.js"), "utf8")).toContain(FIXED.trim().split("\n")[2]);
  expect(await git(["status", "--porcelain"], ws, env)).toBe("");
  expect(await git(["log", "-1", "--format=%s"], ws, env)).toMatch(/^fix: /);
  expect(readFileSync(path.join(result.runDir, "pr.md"), "utf8")).toContain("Fixes #7");
});

(live ? it : it.skip)("stops in orientation when the reported bug is already fixed", { timeout: 15 * 60_000 }, async () => {
  const repo = await createFixtureRepo();
  writeFileSync(path.join(repo, "src", "paginate.js"), FIXED);
  await git(["commit", "-q", "-am", "fix: keep the final item"], repo, env);
  const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-live-"));
  const result = await runContribution(
    { task: fixtureTask(repo) },
    { workdir, env: { ...scrubEnv(), ...env }, reporter: consoleReporter(), limits: { maxCostUsd: 3 } },
  );
  process.stderr.write(`\n${readFileSync(path.join(result.runDir, "report.md"), "utf8")}\n`);
  expect(result.status).toBe("stopped");
  expect(await git(["rev-list", "--count", "main..HEAD"], result.workspace!, env)).toBe("0");
});
