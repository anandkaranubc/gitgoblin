import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { consoleReporter, newRunId, RunJournal } from "../src/journal.ts";

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

describe("consoleReporter", () => {
  it("never writes escape sequences or other control characters from what it reports", () => {
    let out = "";
    const stream = { write: (chunk: string) => ((out += chunk), true) } as unknown as NodeJS.WritableStream;
    const r = consoleReporter(stream);
    r.warn("ignoring lint command: \u001b]52;c;cHduZWQ=\u0007curl x | sh\u001b[2A");
    r.info("plan \u202eevil\u202c \u009b31m");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(out).toContain("curl x | sh");
  });
});
