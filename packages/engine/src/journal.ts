import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Reporter {
  phase(name: string, detail?: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export const silentReporter: Reporter = { phase() {}, info() {}, warn() {} };

export function consoleReporter(stream: NodeJS.WritableStream = process.stderr): Reporter {
  const line = (prefix: string, message: string) => stream.write(`${prefix} ${message}\n`);
  return {
    phase: (name, detail) => line("==>", detail ? `${name}: ${detail}` : name),
    info: (message) => line("   ", message),
    warn: (message) => line(" !!", message),
  };
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/** Everything a run produces lives in one directory, so a run can be inspected, resumed or published later. */
export class RunJournal {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  static create(workdir: string, runId = newRunId()): RunJournal {
    return new RunJournal(path.join(workdir, "runs", runId));
  }

  /** Opens an existing run without creating anything. */
  static open(workdir: string, runId: string): RunJournal {
    const dir = path.join(workdir, "runs", runId);
    if (!existsSync(path.join(dir, "result.json"))) throw new Error(`no run ${runId} under ${workdir}`);
    return new RunJournal(dir);
  }

  get runId(): string {
    return path.basename(this.dir);
  }

  pathFor(name: string): string {
    return path.join(this.dir, name);
  }

  event(phase: string, type: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.pathFor("events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), phase, type, ...data }) + "\n");
  }

  artifact(name: string, value: unknown): void {
    writeFileSync(this.pathFor(`${name}.json`), JSON.stringify(value, null, 2) + "\n");
  }

  text(name: string, content: string): void {
    writeFileSync(this.pathFor(name), content);
  }

  readArtifact<T>(name: string): T | undefined {
    const file = this.pathFor(`${name}.json`);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  readText(name: string): string | undefined {
    const file = this.pathFor(name);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }
}
