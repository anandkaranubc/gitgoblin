import type { Writable } from "node:stream";
import { Worker } from "node:worker_threads";

/*
 * Analysis runs untrusted repository content (issue text, docs, manifests) through regular
 * expressions and parsers. One pathological input must not freeze the whole server: a synchronous
 * hang would block every tool and ignore cancellation. So analysis runs in a worker thread that is
 * terminated when it takes too long or the client cancels.
 */

/** Messages a worker posts back. */
export type WorkerMessage = { type: "log"; message: string } | { type: "result"; value: unknown } | { type: "error"; message: string };

export interface IsolatedOptions {
  /** Terminate the worker after this long. */
  timeoutMs: number;
  /** Aborting terminates the worker (the MCP client cancelled the request). */
  signal?: AbortSignal | undefined;
  onLog?: ((message: string) => void) | undefined;
  /** Where the worker's stdout goes. Never the server's stdout, which carries the protocol. Default stderr. */
  stdoutSink?: Writable | undefined;
  /** Describes the work in the timeout error, e.g. "Analysis of owner/name". */
  label?: string | undefined;
}

export class IsolationTimeoutError extends Error {}

/** Starts `entry` as a worker with `task` as its workerData and resolves with the value it posts. */
export function runInWorker<T>(entry: URL, task: unknown, options: IsolatedOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("cancelled before it started"));
      return;
    }
    const worker = new Worker(entry, { workerData: task, stdout: true });
    worker.stdout.pipe(options.stdoutSink ?? process.stderr, { end: false });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      outcome();
    };
    const timer = setTimeout(() => {
      const minutes = Math.round(options.timeoutMs / 60_000);
      const span = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${options.timeoutMs} ms`;
      finish(() => reject(new IsolationTimeoutError(`${options.label ?? "The work"} stopped after ${span}. The repository may be very large, or something in it made analysis too slow.`)));
    }, options.timeoutMs);
    const onAbort = () => finish(() => reject(new Error("cancelled by the client")));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "log") options.onLog?.(message.message);
      else if (message.type === "result") finish(() => resolve(message.value as T));
      else finish(() => reject(new Error(message.message)));
    });
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => finish(() => reject(new Error(`the analysis worker exited (code ${code}) without a result`))));
  });
}
