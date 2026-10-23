import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRunId, RunJournal } from "../src/journal.ts";

describe("RunJournal", () => {
  it("writes events and artifacts under runs/<id>", () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-j-"));
    const j = RunJournal.create(workdir, "run-1");
    j.event("orient", "start", { a: 1 });
    j.artifact("plan", { steps: ["x"] });
    j.text("pr.md", "# hi");
    expect(j.dir).toBe(path.join(workdir, "runs", "run-1"));
    expect(j.runId).toBe("run-1");
    expect(readFileSync(j.pathFor("events.jsonl"), "utf8")).toMatch(/"phase":"orient","type":"start","a":1/);
    expect(j.readArtifact<{ steps: string[] }>("plan")).toEqual({ steps: ["x"] });
    expect(j.readText("pr.md")).toBe("# hi");
    expect(j.readArtifact("missing")).toBeUndefined();
  });
  it("refuses run ids that leave the runs directory", () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-j-"));
    RunJournal.create(workdir, "20261022-183000-ab12").artifact("result", {});
    expect(() => RunJournal.open(workdir, "20261022-183000-ab12")).not.toThrow();
    expect(() => RunJournal.open(workdir, "../runs/20261022-183000-ab12")).toThrow(/run id/);
    expect(() => RunJournal.open(workdir, "/etc")).toThrow(/run id/);
    expect(() => RunJournal.open(workdir, "")).toThrow(/run id/);
  });
  it("never reuses an existing run directory", () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-j-"));
    RunJournal.create(workdir, "run-2");
    expect(() => RunJournal.create(workdir, "run-2")).toThrow(/EEXIST/);
    const a = RunJournal.create(workdir);
    const b = RunJournal.create(workdir);
    expect(a.dir).not.toBe(b.dir);
  });
  it("makes sortable run ids", () => {
    expect(newRunId(new Date("2026-10-22T18:30:00Z"))).toMatch(/^20261022-183000-[a-z0-9]{4}$/);
  });
});
