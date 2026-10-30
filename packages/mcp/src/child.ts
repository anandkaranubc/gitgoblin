import type { RepoRef } from "@gitgoblin/core";
import { analyzeRepository } from "@gitgoblin/intel";
import type { AnalyzeOptions } from "./deps.ts";
import type { ChildMessage } from "./isolate.ts";

/** What the server sends an analysis child. Plain data: it crosses a process boundary. */
export interface AnalyzeTask {
  kind: "analyze";
  ref: RepoRef;
  options: Omit<AnalyzeOptions, "log" | "signal">;
  cacheDir: string;
}

export function isAnalyzeTask(value: unknown): value is AnalyzeTask {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "analyze";
}

function send(message: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) resolve();
    else process.send(message, () => resolve());
  });
}

/** Runs in the analysis child: wait for the task, analyze, send progress and the result, exit. `analyze` is for tests. */
export async function runAnalysisChild(analyze: typeof analyzeRepository = analyzeRepository): Promise<void> {
  // The server went away without stopping this analysis (killed, or crashed): stop too, and take git along.
  process.once("disconnect", () => {
    try {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL"); // the child leads its own process group
    } catch {}
    process.exit(1);
  });
  // Anything a library prints goes to stderr; the parent forwards it to its own stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const task = await new Promise<unknown>((resolve) => process.once("message", (message: { task?: unknown }) => resolve(message?.task)));
  if (!isAnalyzeTask(task)) {
    await send({ type: "error", message: "unknown analysis task" });
    process.exit(1);
  }
  try {
    const report = await analyze(task.ref, {
      ...task.options,
      cacheDir: task.cacheDir,
      log: (message: string) => void send({ type: "log", message }),
    });
    await send({ type: "result", value: report });
  } catch (error) {
    await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
  process.exit(0);
}
