import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const cli = (args: string[], input = "") =>
  spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, timeout: 30_000 });

describe("gitgoblin-engine publish", () => {
  it("has no flag that skips the confirmation", () => {
    const r = cli(["publish", "20261023-000000-abcd", "--yes"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--yes/);
  });

  it("refuses to publish when nobody is at a terminal, even if 'y' is piped in", () => {
    const r = cli(["publish", "20261023-000000-abcd", "--workdir", mkdtempSync(path.join(os.tmpdir(), "gg-cli-"))], "y\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/person at a terminal/);
  });

  it("shows the title publishing sends, not an edited pr-title.txt", () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), "gg-cli-"));
    const runDir = path.join(workdir, "runs", "20261023-000000-abcd");
    const ws = path.join(runDir, "workspace");
    mkdirSync(path.join(ws, ".git"), { recursive: true });
    const json = (name: string, value: unknown) => writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(value));
    json("result", { status: "awaiting_approval" });
    json("task", { id: "x", repo: { owner: "acme", name: "widgets" }, title: "T" });
    json("workspace", { path: ws, branch: "gitgoblin/fix-1", baseSha: "0".repeat(40), source: "clone" });
    json("delivery", { branch: "gitgoblin/fix-1", commitSha: "a".repeat(40), commitMessage: "m", prTitle: "fix: the prepared title", prBody: "B" });
    writeFileSync(path.join(runDir, "pr-title.txt"), "fix: an edited title\n");
    const r = cli(["publish", "20261023-000000-abcd", "--workdir", workdir, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("pull request: fix: the prepared title");
    expect(r.stdout).toContain("--title fix: the prepared title");
  });

  it("does not mention the removed flag in its usage", () => {
    expect(cli(["--help"]).stdout).not.toContain("--yes");
  });
});

describe("gitgoblin-engine clean", () => {
  it("is listed and needs a run id", () => {
    expect(cli(["--help"]).stdout).toContain("gitgoblin-engine clean <runId>");
    const r = cli(["clean"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs a run id/);
  });
});
