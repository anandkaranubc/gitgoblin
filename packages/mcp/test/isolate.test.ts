import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { IsolationTimeoutError, runInWorker } from "../src/isolate.ts";

const fixture = new URL("./fixtures/worker-fixture.ts", import.meta.url);

describe("runInWorker", () => {
  it("returns the worker's result and forwards its progress", async () => {
    const logs: string[] = [];
    const value = await runInWorker<{ ok: boolean }>(fixture, { mode: "echo" }, { timeoutMs: 10_000, onLog: (m) => logs.push(m) });
    expect(value).toEqual({ ok: true });
    expect(logs).toEqual(["working"]);
  });

  it("keeps the worker's stdout off the server's stdout", async () => {
    const sink = new PassThrough();
    let captured = "";
    sink.on("data", (chunk: Buffer) => {
      captured += chunk.toString();
    });
    await runInWorker(fixture, { mode: "print" }, { timeoutMs: 10_000, stdoutSink: sink });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured).toBe("printed by a library\n");
  });

  it("reports the worker's error", async () => {
    await expect(runInWorker(fixture, { mode: "throw" }, { timeoutMs: 10_000 })).rejects.toThrow("analysis failed: boom");
  });

  it("stops a worker stuck in synchronous code when the time runs out", async () => {
    const started = Date.now();
    const run = runInWorker(fixture, { mode: "hang" }, { timeoutMs: 300, label: "Analysis of acme/widget" });
    await expect(run).rejects.toBeInstanceOf(IsolationTimeoutError);
    await expect(run).rejects.toThrow(/Analysis of acme\/widget stopped after 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a stuck worker when the client cancels", async () => {
    const controller = new AbortController();
    const run = runInWorker(fixture, { mode: "hang" }, { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(run).rejects.toThrow(/cancelled by the client/);
  });
});
