import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentReporter } from "../src/journal.ts";
import { cleanRun, runContribution } from "../src/orchestrator.ts";
import { git } from "../src/workspace.ts";
import { approve, createFixtureRepo, env, FIXED, fixtureTask, investigation, notes, plan, REPRO_TEST, scriptedRunner, type PhaseHandler } from "./helpers/fixture.ts";

const happy: Record<string, PhaseHandler> = {
  orient: (_s, ws) => {
    writeFileSync(path.join(ws, "test/paginate.test.js"), REPRO_TEST);
    return investigation;
  },
  plan: () => plan,
  implement: (_s, ws) => {
    writeFileSync(path.join(ws, "src/paginate.js"), FIXED);
    return notes;
  },
  review: () => approve,
};
const stop: Record<string, PhaseHandler> = { orient: () => ({ ...investigation, feasibility: "stop", reasons: ["already fixed"] }) };

async function runOn(handlers: Record<string, PhaseHandler>) {
  const repo = await createFixtureRepo();
  const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-clean-"));
  const result = await runContribution({ task: fixtureTask(repo) }, { workdir, env, reporter: silentReporter, runnerFactory: (ctx) => scriptedRunner(ctx.workspace, handlers) });
  return { repo, workdir, result };
}

describe("cleanRun", () => {
  it("removes a finished run's workspace, worktree and branch, and keeps its report", async () => {
    const { repo, workdir, result } = await runOn(stop);
    expect(result.status).toBe("stopped");
    expect(await git(["branch", "--list", result.branch!], repo, env)).toContain(result.branch!);
    const cleaned = await cleanRun(result.runId, { workdir, env });
    expect(cleaned.removed).toContain(result.workspace);
    expect(existsSync(result.workspace!)).toBe(false);
    expect(await git(["worktree", "list"], repo, env)).not.toContain(result.workspace!);
    expect(await git(["branch", "--list", result.branch!], repo, env)).toBe("");
    expect(existsSync(path.join(result.runDir, "report.md"))).toBe(true);
    expect(readFileSync(path.join(result.runDir, "events.jsonl"), "utf8")).toContain('"type":"cleaned"');
    // Cleaning twice is harmless.
    expect((await cleanRun(result.runId, { workdir, env })).removed).toEqual([]);
  });

  it("will not discard a prepared change unless told to", async () => {
    const { workdir, result } = await runOn(happy);
    expect(result.status).toBe("awaiting_approval");
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/awaiting approval/);
    expect(existsSync(result.workspace!)).toBe(true);
    await cleanRun(result.runId, { workdir, env, force: true });
    expect(existsSync(result.workspace!)).toBe(false);
    expect(existsSync(path.join(result.runDir, "diff.patch"))).toBe(true);
  });

  it("keeps a published run's workspace while it holds work the published commit does not", async () => {
    const { workdir, result } = await runOn(happy);
    const file = path.join(result.runDir, "result.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "published" }));
    const ws = result.workspace!;
    writeFileSync(path.join(ws, "src/paginate.js"), `${FIXED}\n// review comment answered\n`);
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/was published, and its workspace has changes that are not committed/);
    await git(["commit", "-qam", "answer review"], ws, env);
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/has 1 commit after the published one/);
    expect(existsSync(ws)).toBe(true);
    await cleanRun(result.runId, { workdir, env, force: true });
    expect(existsSync(ws)).toBe(false);
  });

  it("cleans a published run whose workspace holds nothing new, install output aside", async () => {
    const { workdir, result } = await runOn(happy);
    const file = path.join(result.runDir, "result.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "published" }));
    // A repository that does not ignore node_modules still has nothing of the person's in it.
    mkdirSync(path.join(result.workspace!, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(result.workspace!, "node_modules", "x", "index.js"), "");
    expect((await cleanRun(result.runId, { workdir, env })).removed).toContain(result.workspace);
  });

  it("keeps a published run's workspace that git cannot read", async () => {
    const { workdir, result } = await runOn(happy);
    const file = path.join(result.runDir, "result.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "published" }));
    writeFileSync(path.join(result.workspace!, ".git"), "gitdir: /nowhere\n");
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/a state git could not read/);
    expect(existsSync(result.workspace!)).toBe(true);
  });

  it("refuses a workspace record that points outside the run, or a branch it did not create", async () => {
    const { workdir, result } = await runOn(stop);
    const file = path.join(result.runDir, "workspace.json");
    const original = JSON.parse(readFileSync(file, "utf8"));
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "gg-victim-"));
    mkdirSync(path.join(elsewhere, "keep"));
    writeFileSync(file, JSON.stringify({ ...original, path: elsewhere }));
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/outside the run/);
    expect(existsSync(path.join(elsewhere, "keep"))).toBe(true);
    writeFileSync(file, JSON.stringify({ ...original, branch: "main" }));
    await expect(cleanRun(result.runId, { workdir, env })).rejects.toThrow(/not a gitgoblin branch/);
  });
});
