import { type ChildProcess, fork, spawnSync } from "node:child_process";
import { constants } from "node:os";
import type { Writable } from "node:stream";

/*
 * Analysis runs untrusted repository content (issue text, docs, manifests) through regular
 * expressions and parsers, and it runs git. One pathological input must not freeze the server, and
 * a stopped analysis must not leave git running. So each analysis runs in a child process in its own
 * process group: on a timeout or a cancellation the whole group is killed, git included.
 */

/** Messages the child sends back over IPC. */
export type ChildMessage = { type: "log"; message: string } | { type: "result"; value: unknown } | { type: "error"; message: string };

/** The argument that tells the server's entry module to run as an analysis child instead. */
export const CHILD_FLAG = "--gitgoblin-analysis-child";

export interface IsolatedOptions {
  /** Kill the child after this long. */
  timeoutMs: number;
  /** Aborting kills the child (the MCP client cancelled the request). */
  signal?: AbortSignal | undefined;
  onLog?: ((message: string) => void) | undefined;
  /** The child's environment. Default: this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Where the child's stdout and stderr go. Never the server's stdout, which carries the protocol. Default stderr. */
  outputSink?: Writable | undefined;
  /** Describes the work in the timeout error, e.g. "Analysis of owner/name". */
  label?: string | undefined;
  /** Heap limit for the child, in megabytes. */
  maxOldSpaceMb?: number | undefined;
}

export class IsolationTimeoutError extends Error {}

/** Kills a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the child leads its own process group (detached)
  } catch {
    child.kill("SIGKILL");
  }
}

/** Children still running. Each leads its own process group, so nothing stops them when the server goes. */
const live = new Set<ChildProcess>();
let hooked = false;

/** Kills every running child, with what it started, when this process exits, is interrupted or terminated. */
function killChildrenOnExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const child of live) killTree(child);
  });
  // A signal's default action skips "exit" handlers, so exit through them, with the status the signal would give.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => process.exit(128 + constants.signals[signal]));
}

/** Starts `entry` as a child process, sends it `task`, and resolves with the result it sends back. */
export function runInChild<T>(entry: string, task: unknown, options: IsolatedOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("cancelled before it started"));
      return;
    }
    const child = fork(entry, [CHILD_FLAG], {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      // Explicit, so a test runner's or the parent's loader flags are not inherited.
      execArgv: options.maxOldSpaceMb ? [`--max-old-space-size=${options.maxOldSpaceMb}`] : [],
      serialization: "advanced",
    });
    live.add(child);
    killChildrenOnExit();
    const sink = options.outputSink ?? process.stderr;
    child.stdout?.pipe(sink, { end: false });
    child.stderr?.pipe(sink, { end: false });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      killTree(child);
      live.delete(child);
      outcome();
    };
    const timer = setTimeout(() => {
      const minutes = Math.round(options.timeoutMs / 60_000);
      const span = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${options.timeoutMs} ms`;
      finish(() => reject(new IsolationTimeoutError(`${options.label ?? "The work"} stopped after ${span}. The repository may be very large, or something in it made analysis too slow.`)));
    }, options.timeoutMs);
    const onAbort = () => finish(() => reject(new Error("cancelled by the client")));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (message: ChildMessage) => {
      if (message.type === "log") options.onLog?.(message.message);
      else if (message.type === "result") finish(() => resolve(message.value as T));
      else finish(() => reject(new Error(message.message)));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => reject(new Error(`the analysis process exited (${code ?? signal}) without a result`))));
    child.send({ type: "task", task });
  });
}

/** At most `limit` tasks at once; the rest wait their turn. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}
