import { parentPort, workerData } from "node:worker_threads";
import type { RepoRef } from "@gitgoblin/core";
import { analyzeRepository } from "@gitgoblin/intel";
import type { AnalyzeOptions } from "./deps.ts";
import type { WorkerMessage } from "./isolate.ts";

/** What the server sends a worker. Plain data: it crosses a thread boundary. */
export interface AnalyzeTask {
  kind: "analyze";
  ref: RepoRef;
  options: Omit<AnalyzeOptions, "log" | "signal">;
  cacheDir: string;
}

export function isAnalyzeTask(value: unknown): value is AnalyzeTask {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "analyze";
}

/** Runs inside the worker thread: analyze, report progress, post the result. */
export async function runWorkerTask(): Promise<void> {
  const post = (message: WorkerMessage) => parentPort?.postMessage(message);
  // Anything a library prints goes to stderr, never to the protocol channel.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  if (!isAnalyzeTask(workerData)) {
    post({ type: "error", message: "unknown worker task" });
    return;
  }
  const task = workerData;
  try {
    const report = await analyzeRepository(task.ref, {
      ...task.options,
      cacheDir: task.cacheDir,
      log: (message: string) => post({ type: "log", message }),
    });
    post({ type: "result", value: report });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
