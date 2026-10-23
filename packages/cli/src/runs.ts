import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import type { RunResult } from "@gitgoblin/engine";
import type { Style } from "./format.ts";

/**
 * Reads what the engine leaves in `<workdir>/runs/<id>/`: `result.json`, `task.json`, `report.md`,
 * and for a prepared change `pr-title.txt`, `pr.md` and `diff.patch`. The layout is documented in
 * packages/engine/README.md; nothing here is written, only read.
 */

export interface RunSummary {
  runId: string;
  status: RunResult["status"];
  reason: string;
  costUsd: number;
  title: string | undefined;
  repo: string | undefined;
}

export interface RunFiles {
  dir: string;
  result: RunResult;
  report: string | undefined;
  prTitle: string | undefined;
  prBody: string | undefined;
  diff: string | undefined;
  diffPath: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Run ids are a timestamp plus a suffix; anything else (a path, say) is not a run, here and in the engine. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function readRun(workdir: string, runId: string): RunFiles | undefined {
  if (!isRunId(runId)) return undefined;
  const dir = join(workdir, "runs", runId);
  const result = readJson<RunResult>(join(dir, "result.json"));
  if (!result) return undefined;
  return {
    dir,
    result,
    report: readText(join(dir, "report.md")),
    prTitle: readText(join(dir, "pr-title.txt"))?.trim() || undefined,
    prBody: readText(join(dir, "pr.md")),
    diff: readText(join(dir, "diff.patch")),
    diffPath: join(dir, "diff.patch"),
  };
}

/** Every run with a result, newest first. Run ids start with a timestamp, so they sort by time. */
export function listRuns(workdir: string): RunSummary[] {
  const root = join(workdir, "runs");
  if (!existsSync(root)) return [];
  const runs: RunSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isRunId(entry.name)) continue;
    const result = readJson<RunResult>(join(root, entry.name, "result.json"));
    if (!result) continue;
    const task = readJson<{ title?: string; repo?: { owner?: string; name?: string } }>(join(root, entry.name, "task.json"));
    const repo = task?.repo?.owner && task.repo.name ? `${task.repo.owner}/${task.repo.name}` : undefined;
    runs.push({ runId: entry.name, status: result.status, reason: result.reason, costUsd: result.costUsd, title: task?.title, repo });
  }
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

export function formatRuns(runs: RunSummary[], style: Style, workdirFlag = ""): string {
  if (runs.length === 0) return "No runs yet. `gitgoblin contribute <repo>` starts one.";
  const dim = (text: string) => (style.color ? styleText("dim", text) : text);
  return runs
    .map((run) => {
      const head = [run.runId, run.status.padEnd(17), `$${run.costUsd.toFixed(2)}`, run.repo, run.title].filter((part) => part !== undefined).join("  ");
      const detail = run.status === "awaiting_approval" ? `publish with: gitgoblin publish ${run.runId}${workdirFlag}` : run.reason;
      return `${head}\n    ${dim(detail)}`;
    })
    .join("\n");
}
