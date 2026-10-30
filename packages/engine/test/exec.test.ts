import { describe, expect, it } from "vitest";
import { excerpt, execFile, execShell, keptOutput, killAllChildren, liveChildCount, tail } from "../src/exec.ts";

const opts = { cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "" } };

describe("excerpt", () => {
  it("returns short output whole and keeps both ends of long output", () => {
    expect(excerpt({ output: "short", truncated: false })).toBe("short");
    const long = `FIRST${"x".repeat(10_000)}LAST`;
    const cut = excerpt({ output: long, truncated: false }, 1000, 100);
    expect(cut.startsWith("FIRST")).toBe(true);
    expect(cut.endsWith("LAST")).toBe(true);
    expect(cut).toContain(`[... ${long.length - 1000} characters omitted ...]`);
  });
});

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

  it("caps output to the configured size and says so", async () => {
    const r = await execShell("yes | head -c 50000", { ...opts, maxOutputBytes: 1000 });
    expect(r.output.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
    expect((await execShell("echo small", opts)).truncated).toBe(false);
  });

  it("keeps the start of output it had to cut, where the first error usually is", async () => {
    const r = await execShell("echo 'Error: firefox would not launch'; yes filler | head -c 50000; echo LAST", { ...opts, maxOutputBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("firefox");
    expect(r.head?.startsWith("Error: firefox would not launch")).toBe(true);
    const short = excerpt(r, 600, 100);
    expect(short).toContain("Error: firefox");
    expect(short).toContain("[... the middle of a long output omitted ...]");
    expect(short.trimEnd().endsWith("LAST")).toBe(true);
    const kept = keptOutput(r);
    expect(kept.startsWith("Error: firefox")).toBe(true);
    expect(kept.trimEnd().endsWith("LAST")).toBe(true);
  });

  it("kills every live child when the engine is told to shut down", async () => {
    const pending = execShell("sleep 30; echo late", { ...opts, timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(liveChildCount()).toBeGreaterThan(0);
    killAllChildren();
    const r = await pending;
    expect(r.output).not.toContain("late");
    expect(r.exitCode).not.toBe(0);
    expect(liveChildCount()).toBe(0);
  });
});

describe("execFile", () => {
  it("runs without a shell", async () => {
    const r = await execFile("echo", ["$HOME"], opts);
    expect(r.output.trim()).toBe("$HOME");
  });
  it("keeps a character whose bytes arrive in separate writes", async () => {
    const r = await execFile(process.execPath, ["-e", "const b = Buffer.from('é'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)"], opts);
    expect(r.output).toBe("é");
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
