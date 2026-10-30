import { describe, expect, it } from "vitest";
import { SessionCostTracker } from "../src/agent.ts";

describe("SessionCostTracker", () => {
  it("reports only the increase for resumed sessions", () => {
    const costs = new SessionCostTracker();
    expect(costs.delta("s1", undefined, 1.0)).toBe(1.0);
    expect(costs.delta("s1", "s1", 1.5)).toBe(0.5);
    expect(costs.delta("s1", "s1", 3.5)).toBe(2.0);
    // A fresh session starts from zero.
    expect(costs.delta("s2", undefined, 0.6)).toBe(0.6);
    // A fork gets a new id but continues from the parent's total.
    expect(costs.delta("s3", "s1", 4.0)).toBe(0.5);
  });
  it("never reports a negative delta", () => {
    const costs = new SessionCostTracker();
    costs.delta("s1", undefined, 2);
    expect(costs.delta("s1", "s1", 1)).toBe(0);
  });
});

import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createSdkRunner, type PhaseSpec } from "../src/agent.ts";

type Msg = Record<string, unknown>;

/** A scripted stand-in for the SDK's query(): each call yields the next scripted message list and records its options. */
function scriptedQuery(scripts: Msg[][]) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const query = (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    const script = scripts[calls.length - 1] ?? [];
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
  return { query: query as never, calls };
}

const Output = z.object({ done: z.boolean() });
const spec: PhaseSpec<{ done: boolean }> = { name: "orient", systemPrompt: "s", prompt: "p", schema: Output, profile: "build", maxTurns: 5, maxBudgetUsd: 1 };
const init = (id: string): Msg => ({ type: "system", subtype: "init", session_id: id });
const success = (id: string, total: number, turns: number): Msg => ({ type: "result", subtype: "success", session_id: id, total_cost_usd: total, num_turns: turns, structured_output: { done: true }, result: "ok", errors: [] });
const failure = (id: string, subtype: string, errors: string[], total = 0.1): Msg => ({ type: "result", subtype, session_id: id, total_cost_usd: total, num_turns: 2, errors });

describe("createSdkRunner temp directory", () => {
  it("gives a sandboxed agent the run's temp directory", async () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg-run-tmp-")));
    const { query, calls } = scriptedQuery([[init("s1"), success("s1", 0.1, 1)]]);
    await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, env: { TMPDIR: "/shared" }, tmp, query }).run(spec);
    const options = calls[0]!.options as { env: Record<string, string>; sandbox: { filesystem: { allowWrite: string[] } } };
    expect(options.env).toMatchObject({ TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    expect(options.sandbox.filesystem.allowWrite).toContain(tmp);
  });
});

describe("createSdkRunner transient failures", () => {
  it("resumes the session once after an error during execution", async () => {
    const { query, calls } = scriptedQuery([
      [init("s1"), failure("s1", "error_during_execution", ["fetch failed: ECONNRESET"])],
      [init("s1"), success("s1", 0.3, 4)],
    ]);
    const runner = createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query });
    const result = await runner.run(spec);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ done: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options["resume"]).toBe("s1");
    expect(String(calls[1]?.prompt)).toMatch(/interrupted/i);
    expect(result.costUsd).toBeCloseTo(0.3, 5);
    expect(result.turns).toBe(6);
    expect(result.errors).toContain("error_during_execution");
  });

  it("gives up after the second failure instead of looping", async () => {
    const { query, calls } = scriptedQuery([
      [init("s1"), failure("s1", "error_during_execution", ["boom"])],
      [init("s1"), failure("s1", "error_during_execution", ["boom again"])],
    ]);
    const runner = createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query });
    const result = await runner.run(spec);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(result.errors).toEqual(expect.arrayContaining(["boom", "boom again"]));
  });

  it("does not retry when the session never started or the failure is not transient", async () => {
    const noSession = scriptedQuery([[failure("", "error_during_execution", ["invalid api key"])]]);
    const r1 = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query: noSession.query }).run({ ...spec });
    expect(r1.ok).toBe(false);
    expect(noSession.calls).toHaveLength(1);

    const refused = scriptedQuery([[init("s2"), failure("s2", "error_max_structured_output_retries", ["could not produce output"])]]);
    const r2 = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query: refused.query }).run({ ...spec });
    expect(r2.ok).toBe(false);
    expect(refused.calls).toHaveLength(1);
  });

  it("still asks an exhausted session to wrap up, with no tools", async () => {
    const { query, calls } = scriptedQuery([
      [init("s3"), failure("s3", "error_max_turns", [], 0.5)],
      [init("s3"), success("s3", 0.6, 1)],
    ]);
    const result = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query }).run(spec);
    expect(result.ok).toBe(true);
    expect(calls[1]?.options["allowedTools"]).toEqual([]);
    expect(result.costUsd).toBeCloseTo(0.6, 5);
  });
});

describe("createSdkRunner deadlines", () => {
  it("aborts a phase that outlives its deadline and reports it as timed out", async () => {
    const calls: { options: Record<string, unknown> }[] = [];
    const hanging = ((args: { options: Record<string, unknown> }) => {
      calls.push(args);
      const signal = (args.options["abortController"] as AbortController).signal;
      return (async function* () {
        yield init("s9");
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
          setTimeout(resolve, 10_000);
        });
      })();
    }) as never;
    const started = Date.now();
    const result = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query: hanging }).run({ ...spec, timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/timed out after/);
    // A deadline is not a transient failure: no resume.
    expect(calls).toHaveLength(1);
  });

  it("keeps a resume and a wrap-up within the phase's deadline instead of starting it again", async () => {
    const calls: unknown[] = [];
    const slow = ((args: { options: Record<string, unknown> }) => {
      calls.push(args);
      const n = calls.length;
      const signal = (args.options["abortController"] as AbortController).signal;
      return (async function* () {
        yield init("s4");
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
          setTimeout(resolve, 250);
        });
        yield n === 1 ? failure("s4", "error_during_execution", ["overloaded"]) : n === 2 ? failure("s4", "error_max_turns", []) : success("s4", 0.3, 1);
      })();
    }) as never;
    const started = Date.now();
    const result = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query: slow }).run({ ...spec, timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/timed out after/);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("passes no deadline when none is set", async () => {
    const { query, calls } = scriptedQuery([[init("s1"), success("s1", 0.1, 1)]]);
    const result = await createSdkRunner({ workspace: "/ws", task: { kind: "issue" }, isolation: "none", env: {}, query }).run(spec);
    expect(result.ok).toBe(true);
    expect((calls[0]?.options["abortController"] as AbortController).signal.aborted).toBe(false);
  });
});
