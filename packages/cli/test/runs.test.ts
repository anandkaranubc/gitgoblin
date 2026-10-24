import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directorySize, formatBytes, formatRuns, installSummary, listRuns, readRun } from "../src/runs.ts";
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

describe("the install step", () => {
  const PNPM = "Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK\n\n  × lock the package-manager engine store\n  ╰─▶ Failed to open the store operation lock at \"pnpm-store-operation-locks\":\n      Operation not permitted (os error 1)\n";

  it("is read from the run's events and log", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261023-163018-bnlx", { status: "escalated", install: { exitCode: 1, output: PNPM } });
    const run = readRun(workdir, "20261023-163018-bnlx");
    expect(run?.install).toEqual({ exitCode: 1, timedOut: false, logPath: join(workdir, "runs", "20261023-163018-bnlx", "install-output.txt"), output: PNPM, refused: [] });
    writeRun(workdir, "20261023-163019-none");
    expect(readRun(workdir, "20261023-163019-none")?.install).toBeUndefined();
  });

  it("is summarised only when it failed, with the end of the log and where the rest is", () => {
    const logPath = "/w/runs/r/install-output.txt";
    expect(installSummary({ exitCode: 0, timedOut: false, logPath, output: "ok", refused: [] })).toBeUndefined();
    const lines = installSummary({ exitCode: 1, timedOut: false, logPath, output: PNPM, refused: [] })!;
    expect(lines[0]).toBe("The repository's install failed (exit 1). End of /w/runs/r/install-output.txt:");
    expect(lines.some((line) => line.includes("Operation not permitted (os error 1)"))).toBe(true);
    expect(lines.every((line) => line.trim() !== "")).toBe(true);
    const long = installSummary({ exitCode: 2, timedOut: false, logPath, output: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), refused: [] }, 5)!;
    expect(long.slice(1)).toEqual(["  line 35", "  line 36", "  line 37", "  line 38", "  line 39"]);
    expect(installSummary({ exitCode: null, timedOut: true, logPath, output: "", refused: [] })![0]).toBe("The repository's install timed out. End of /w/runs/r/install-output.txt:");
    expect(installSummary({ exitCode: 1, timedOut: false, logPath, output: "\u001b[31mred\u001b[0m", refused: [] })).toContain("  red");
  });
});

describe("disk use", () => {
  it("formats sizes the way people read them", () => {
    expect(formatBytes(640 * 1024)).toBe("640 KB");
    expect(formatBytes(531 * 1024 * 1024)).toBe("531 MB");
    expect(formatBytes(2.7 * 1024 ** 3)).toBe("2.7 GB");
    expect(formatBytes(0)).toBe("0 KB");
  });

  it("measures a run's folder, and knows which finished runs still keep their workspace", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    const dir = writeRun(workdir, "20261023-182616-x3md", { status: "stopped", workspaceBytes: 300_000 });
    writeRun(workdir, "20261023-171222-u5ul", { status: "awaiting_approval", workspaceBytes: 1000 });
    writeRun(workdir, "20261023-053806-6u65", { status: "failed" });
    expect(directorySize(dir)).toBeGreaterThanOrEqual(300_000);
    const runs = listRuns(workdir);
    expect(runs.find((r) => r.runId === "20261023-182616-x3md")?.keepsWorkspace).toBe(true);
    expect(runs.find((r) => r.runId === "20261023-053806-6u65")?.keepsWorkspace).toBe(false);
    const text = formatRuns(runs, { color: false });
    expect(text).toContain("1 finished run still keeps its workspace; `gitgoblin clean --finished` removes it (reports and diffs stay).");
  });

  it("says nothing about cleaning when no finished run keeps a workspace", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261023-171222-u5ul", { status: "awaiting_approval", workspaceBytes: 1000 });
    expect(formatRuns(listRuns(workdir), { color: false })).not.toContain("clean");
  });
});

describe("an install limited to package registries", () => {
  it("names the hosts it refused and how to allow them, only when the install failed", () => {
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-runs-"));
    writeRun(workdir, "20261023-210000-aaaa", { status: "escalated", install: { exitCode: 1, output: "npm ERR! fetch failed", network: "registries", refused: ["gitlab.com", "example.org"] } });
    const install = readRun(workdir, "20261023-210000-aaaa")!.install!;
    expect(install.refused).toEqual(["gitlab.com", "example.org"]);
    const lines = installSummary(install)!;
    expect(lines.at(-1)).toBe("The install tried gitlab.com and example.org, which are not package registries. If you trust them, run again with --install-network open.");

    writeRun(workdir, "20261023-210000-bbbb", { status: "stopped", install: { exitCode: 0, output: "ok", network: "registries", refused: ["example.org"] } });
    expect(installSummary(readRun(workdir, "20261023-210000-bbbb")!.install!)).toBeUndefined();
  });
});
