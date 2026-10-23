import { spawn } from "node:child_process";

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr interleaved in arrival order, capped to the last `maxOutputBytes`. */
  output: string;
  durationMs: number;
  timedOut: boolean;
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

function run(file: string, args: string[], display: string, opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group so a timeout can kill whatever the command spawned.
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > maxBytes * 2) output = output.slice(-maxBytes);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ command: display, exitCode, signal, output: output.slice(-maxBytes), durationMs: Date.now() - started, timedOut });
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
