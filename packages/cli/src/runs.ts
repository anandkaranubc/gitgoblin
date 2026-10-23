import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import type { RunResult } from "@gitgoblin/engine";
import type { Style } from "./format.ts";
import { plain } from "./text.ts";

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
  /** The run's workspace (a clone with its dependencies, often hundreds of megabytes) is still on disk. */
  keepsWorkspace: boolean;
}

/** The repository's install step as the engine recorded it: an `install` event and `install-output.txt`. */
export interface InstallRecord {
  /** null when the install was killed or timed out. */
  exitCode: number | null;
  timedOut: boolean;
  logPath: string;
  output: string | undefined;
}

export interface RunFiles {
  dir: string;
  result: RunResult;
  /** Undefined when the run never got to an install command. */
  install: InstallRecord | undefined;
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
    install: readInstall(dir),
  };
}

/** Reads the install step from a run directory; undefined when the run never got to an install command. */
export function readInstall(dir: string): InstallRecord | undefined {
  let end: { exitCode?: unknown; timedOut?: unknown } | undefined;
  for (const line of (readText(join(dir, "events.jsonl")) ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { phase?: unknown; type?: unknown };
      if (event.phase === "install" && event.type === "end") end = event as typeof end;
    } catch {
      // a torn last line from a crashed run; the earlier events still count
    }
  }
  if (!end) return undefined;
  const logPath = join(dir, "install-output.txt");
  return { exitCode: typeof end.exitCode === "number" ? end.exitCode : null, timedOut: end.timedOut === true, logPath, output: readText(logPath) };
}

/** For a failed install: what happened, then the last lines of its log, which usually name the cause. */
export function installSummary(install: InstallRecord, lines = 12): string[] | undefined {
  if (install.exitCode === 0 && !install.timedOut) return undefined;
  const what = install.timedOut ? "timed out" : install.exitCode === null ? "did not finish" : `failed (exit ${install.exitCode})`;
  const tail = plain(install.output ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .map((line) => `  ${line}`);
  return [`The repository's install ${what}. End of ${install.logPath}:`, ...tail];
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
    const workspace = readJson<{ path?: unknown }>(join(root, entry.name, "workspace.json"));
    const keepsWorkspace = typeof workspace?.path === "string" && existsSync(workspace.path);
    runs.push({ runId: entry.name, status: result.status, reason: result.reason, costUsd: result.costUsd, title: task?.title, repo, keepsWorkspace });
  }
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

export function formatRuns(runs: RunSummary[], style: Style, workdirFlag = ""): string {
  if (runs.length === 0) return "No runs yet. `gitgoblin contribute <repo>` starts one.";
  const dim = (text: string) => (style.color ? styleText("dim", text) : text);
  const finished = runs.filter((run) => run.keepsWorkspace && run.status !== "awaiting_approval").length;
  const hint = finished
    ? `\n\n${dim(`${finished} finished run${finished === 1 ? " still keeps its" : "s still keep their"} workspace; \`gitgoblin clean --finished${workdirFlag}\` removes ${finished === 1 ? "it" : "them"} (reports and diffs stay).`)}`
    : "";
  return runs
    .map((run) => {
      const head = [run.runId, run.status.padEnd(17), `$${run.costUsd.toFixed(2)}`, run.repo, run.title === undefined ? undefined : plain(run.title)].filter((part) => part !== undefined).join("  ");
      const detail = run.status === "awaiting_approval" ? `publish with: gitgoblin publish ${run.runId}${workdirFlag}` : plain(run.reason);
      return `${head}\n    ${dim(detail)}`;
    })
    .join("\n") + hint;
}

/** Bytes under `path`, counting files and symlinks themselves, never following a link. */
export function directorySize(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } else {
      total += stat.size;
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
