import { spawn } from "node:child_process";

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr interleaved in arrival order, capped to the last `maxOutputBytes`. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** True when more than `maxOutputBytes` arrived and the start of the output was dropped. */
  truncated: boolean;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 512 * 1024;
/** After the process exits, how long to wait for stray children holding its pipes. */
const STDIO_GRACE_MS = 2000;

/**
 * Every command runs in its own process group so a timeout can take its children with it. The
 * groups are tracked so that when the engine itself exits or is interrupted, nothing it started
 * (an install, a test suite, a server a test left behind) keeps running on the operator's machine.
 */
const live = new Map<number, () => void>();
let handlersInstalled = false;

export function liveChildCount(): number {
  return live.size;
}

/** Kills every process group the engine started. Safe to call more than once. */
export function killAllChildren(): void {
  for (const kill of [...live.values()]) kill();
}

function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", killAllChildren);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      killAllChildren();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

function run(file: string, args: string[], display: string, opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group so a timeout can kill whatever the command spawned.
    installExitHandlers();
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let received = 0;
    let timedOut = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      received += chunk.length;
      output += chunk.toString("utf8");
      if (output.length > maxBytes * 2) output = output.slice(-maxBytes);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    if (child.pid) live.set(child.pid, killGroup);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (child.pid) live.delete(child.pid);
      resolve({ command: display, exitCode, signal, output: output.slice(-maxBytes), durationMs: Date.now() - started, timedOut, truncated: received > maxBytes });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null, null);
    });
    // `close` waits for the pipes; a daemon left behind could hold them open, so `exit` starts a grace period.
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => {
        killGroup();
        finish(code, signal);
      }, STDIO_GRACE_MS);
    });
    child.on("close", finish);
  });
}

/** Runs a command line through `/bin/sh -c`. Use for repository commands written by humans (`npm test`). */
export function execShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return run("/bin/sh", ["-c", command], command, opts);
}

/** Runs an executable with explicit arguments and no shell. Use for git and gh. */
export function execFile(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return run(file, args, [file, ...args].join(" "), opts);
}

/** Last `maxChars` of a text, with a marker when something was cut. */
export function tail(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} characters omitted ...]\n${text.slice(-maxChars)}`;
}
