import { describe, expect, it } from "vitest";
import { execFile, execShell, tail } from "../src/exec.ts";

const opts = { cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "" } };

describe("execShell", () => {
  it("captures output and exit code", async () => {
    const r = await execShell("echo out; echo err 1>&2; exit 3", opts);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.timedOut).toBe(false);
  });

  it("kills a command that exceeds the timeout", async () => {
    const r = await execShell("sleep 5; echo late", { ...opts, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.output).not.toContain("late");
  });

  it("caps output to the configured size", async () => {
    const r = await execShell("yes | head -c 50000", { ...opts, maxOutputBytes: 1000 });
    expect(r.output.length).toBeLessThanOrEqual(1000);
  });
});

describe("execFile", () => {
  it("runs without a shell", async () => {
    const r = await execFile("echo", ["$HOME"], opts);
    expect(r.output.trim()).toBe("$HOME");
  });
  it("reports a missing executable instead of throwing", async () => {
    const r = await execFile("definitely-not-a-command-xyz", [], opts);
    expect(r.exitCode).not.toBe(0);
  });
});

describe("tail", () => {
  it("keeps the end and says what was cut", () => {
    const t = tail("a".repeat(100), 10);
    expect(t.endsWith("a".repeat(10))).toBe(true);
    expect(t).toContain("90 characters omitted");
  });
});
