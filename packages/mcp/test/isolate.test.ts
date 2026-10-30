import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHILD_FLAG, IsolationTimeoutError, runInChild, Semaphore } from "../src/isolate.ts";

const fixture = fileURLToPath(new URL("./fixtures/child-fixture.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "gitgoblin-isolate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runInChild", () => {
  it("returns the child's result and forwards its progress", async () => {
    const logs: string[] = [];
    const value = await runInChild<{ ok: boolean }>(fixture, { mode: "echo" }, { timeoutMs: 20_000, onLog: (m) => logs.push(m) });
    expect(value).toEqual({ ok: true });
    expect(logs).toEqual(["working"]);
  });

  it("keeps the child's output off the server's stdout", async () => {
    const sink = new PassThrough();
    let captured = "";
    sink.on("data", (chunk: Buffer) => {
      captured += chunk.toString();
    });
    await runInChild(fixture, { mode: "print" }, { timeoutMs: 20_000, outputSink: sink });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(captured).toContain("printed by a library");
  });

  it("reports the child's error", async () => {
    await expect(runInChild(fixture, { mode: "throw" }, { timeoutMs: 20_000 })).rejects.toThrow("analysis failed: boom");
  });

  it("runs the child with exactly the environment it is given", async () => {
    const value = await runInChild<{ home: string; token: string | null }>(fixture, { mode: "env" }, { timeoutMs: 20_000, env: { PATH: process.env.PATH, HOME: "/nowhere", GITHUB_TOKEN: "t0ken" } });
    expect(value).toMatchObject({ home: "/nowhere", token: "t0ken" });
  });

  it("stops a child stuck in synchronous code when the time runs out", async () => {
    const started = Date.now();
    const run = runInChild(fixture, { mode: "hang" }, { timeoutMs: 1_500, label: "Analysis of acme/widget" });
    await expect(run).rejects.toBeInstanceOf(IsolationTimeoutError);
    await expect(run).rejects.toThrow(/Analysis of acme\/widget stopped after 1500 ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === "win32")("kills what the child started, not just the child", async () => {
    const pidFile = join(scratch, "grandchild.pid");
    const run = runInChild(fixture, { mode: "grandchild", pidFile }, { timeoutMs: 2_500 });
    await expect(run).rejects.toBeInstanceOf(IsolationTimeoutError);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  });

  it("stops a stuck child when the client cancels", async () => {
    const controller = new AbortController();
    const run = runInChild(fixture, { mode: "hang" }, { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 1_000);
    await expect(run).rejects.toThrow(/cancelled by the client/);
  });
});

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) if (check()) return true;
  return check();
}

describe.skipIf(process.platform === "win32")("a child never outlives the server", () => {
  const server = fileURLToPath(new URL("./fixtures/server-fixture.ts", import.meta.url));

  for (const how of ["exit", "SIGTERM", "SIGINT"]) {
    it(`kills a running analysis and what it started when the server ${how === "exit" ? "exits" : `gets ${how}`}`, async () => {
      const pidFile = join(scratch, `orphan-${how}.pid`);
      const parent = spawn(process.execPath, [server, fixture, pidFile, how], { stdio: "ignore" });
      await once(parent, "exit");
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        expect(await waitFor(() => !alive(pid))).toBe(true);
      } finally {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    });
  }

  it("stops an analysis child whose server went away without a word", async () => {
    const entry = fileURLToPath(new URL("./fixtures/analysis-child-fixture.ts", import.meta.url));
    const child = fork(entry, [CHILD_FLAG], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true, execArgv: [], serialization: "advanced" });
    try {
      const started = once(child, "message");
      child.send({ type: "task", task: { kind: "analyze", ref: { host: "github.com", owner: "acme", name: "widget" }, options: {}, cacheDir: scratch } });
      expect((await started)[0]).toEqual({ type: "log", message: "started" });
      child.disconnect();
      expect(await waitFor(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("Semaphore", () => {
  it("runs at most `limit` tasks at once", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});
