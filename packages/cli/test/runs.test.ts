import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRuns, listRuns, readRun } from "../src/runs.ts";
import { writeRun } from "./fixtures.ts";

describe("listRuns", () => {
  it("reads every run directory that has a result, newest first, with its task title", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261021-120000-aaaa", { status: "stopped", reason: "plan rejected by the operator", title: "Fix #7: older" });
    writeRun(workdir, "20261022-093000-bbbb");
    mkdirSync(join(workdir, "runs", "20261022-100000-cccc"), { recursive: true }); // crashed before writing a result
    const runs = listRuns(workdir);
    expect(runs.map((r) => r.runId)).toEqual(["20261022-093000-bbbb", "20261021-120000-aaaa"]);
    expect(runs[0]).toMatchObject({ status: "awaiting_approval", title: "Fix #42: --color flag is ignored on Windows", repo: "acme/widget", costUsd: 0.42 });
    expect(runs[1]).toMatchObject({ status: "stopped", reason: "plan rejected by the operator", title: "Fix #7: older" });
  });

  it("lists only directories named like run ids, so runs and show agree on what exists", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261022-093000-bbbb");
    writeRun(workdir, "has space");
    writeRun(workdir, "x".repeat(82));
    expect(listRuns(workdir).map((r) => r.runId)).toEqual(["20261022-093000-bbbb"]);
    expect(readRun(workdir, "x".repeat(82))).toBeUndefined();
  });

  it("returns nothing for a workdir without runs", () => {
    expect(listRuns(join(tmpdir(), "gitgoblin-nowhere-" + Date.now()))).toEqual([]);
  });
});

describe("readRun", () => {
  it("returns the result and the files a person reads, or undefined for an unknown run", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261022-093000-bbbb");
    const run = readRun(workdir, "20261022-093000-bbbb");
    expect(run?.result.status).toBe("awaiting_approval");
    expect(run?.report).toContain("# gitgoblin run 20261022-093000-bbbb");
    expect(run?.prTitle).toBe("fix: honour --color on Windows");
    expect(run?.prBody).toContain("Fixes #42");
    expect(run?.diff).toContain("diff --git");
    expect(run?.diffPath).toBe(join(workdir, "runs", "20261022-093000-bbbb", "diff.patch"));
    expect(readRun(workdir, "nope")).toBeUndefined();
  });

  it("treats anything but a plain run id as unknown, so a path never escapes the runs directory", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261022-093000-bbbb");
    mkdirSync(join(workdir, "elsewhere"), { recursive: true });
    writeRun(join(workdir, "elsewhere"), "20261022-093000-bbbb");
    expect(readRun(workdir, "../elsewhere/runs/20261022-093000-bbbb")).toBeUndefined();
    expect(readRun(workdir, "20261022-093000-bbbb/..")).toBeUndefined();
    expect(readRun(workdir, "")).toBeUndefined();
    expect(readRun(workdir, "20261022-093000-bbbb")).toBeDefined();
  });
});

describe("formatRuns", () => {
  it("renders one line per run with what matters for deciding what to do with it", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261022-093000-bbbb");
    writeRun(workdir, "20261021-120000-aaaa", { status: "escalated", reason: "plan adds a dependency", costUsd: 1.2 });
    const text = formatRuns(listRuns(workdir), { color: false });
    expect(text).toContain("20261022-093000-bbbb  awaiting_approval  $0.42  acme/widget  Fix #42: --color flag is ignored on Windows");
    expect(text).toContain("20261021-120000-aaaa  escalated          $1.20  acme/widget  Fix #42: --color flag is ignored on Windows");
    expect(text).toContain("plan adds a dependency");
    expect(formatRuns([], { color: false })).toMatch(/No runs yet/);
  });
});

describe("formatRuns shows task titles without control characters", () => {
  it("strips escape sequences from the title the engine recorded", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261022-093000-bbbb", { title: "Fix #42: \u001b[31mred\u001b[0m" });
    const text = formatRuns(listRuns(workdir), { color: false });
    expect(text).toContain("acme/widget  Fix #42: red");
    expect(text).not.toContain("\u001b");
  });
});
