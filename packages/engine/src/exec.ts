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
  /**
   * The first characters of the output, kept even when `output` lost its start: the first error is
   * usually the one that explains the rest (a browser that would not launch, a missing module).
   */
  head?: string;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Runs the shell command inside something else, for example an OS sandbox. Only `execShell` uses it. */
  wrap?: (command: string) => { file: string; args: string[] };
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 512 * 1024;
const HEAD_CHARS = 16 * 1024;
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
    let head = "";
    let received = 0;
    let timedOut = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      received += chunk.length;
      const text = chunk.toString("utf8");
      if (head.length < HEAD_CHARS) head += text.slice(0, HEAD_CHARS - head.length);
      output += text;
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
      resolve({ command: display, exitCode, signal, output: output.slice(-maxBytes), durationMs: Date.now() - started, timedOut, truncated: received > maxBytes, head });
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
  const wrapped = opts.wrap ? opts.wrap(command) : { file: "/bin/sh", args: ["-c", command] };
  return run(wrapped.file, wrapped.args, command, opts);
}

/** Runs an executable with explicit arguments and no shell. Use for git and gh. */
export function execFile(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return run(file, args, [file, ...args].join(" "), opts);
}

/**
 * The start and the end of a command's output within `maxChars`, with a marker where the middle was
 * cut. A tail alone loses the first error, which often explains every later one.
 */
export function excerpt(result: Pick<ExecResult, "output" | "truncated" | "head">, maxChars = 6000, headChars = 1500): string {
  const { output } = result;
  if (!result.truncated && output.length <= maxChars) return output;
  const start = (result.truncated ? (result.head ?? "") : output).slice(0, headChars);
  const end = output.slice(-(maxChars - start.length));
  const omitted = result.truncated ? "the middle of a long output" : `${output.length - start.length - end.length} characters`;
  return `${start}\n[... ${omitted} omitted ...]\n${end}`;
}

/** Everything a command printed that was kept: the whole output, or its start and its last part when it was cut. */
export function keptOutput(result: Pick<ExecResult, "output" | "truncated" | "head">): string {
  return result.truncated && result.head ? `${result.head}\n[... the middle of the output was too long to keep ...]\n${result.output}` : result.output;
}

/** Last `maxChars` of a text, with a marker when something was cut. */
export function tail(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} characters omitted ...]\n${text.slice(-maxChars)}`;
}
