import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

  it("does not mention the removed flag in its usage", () => {
    expect(cli(["--help"]).stdout).not.toContain("--yes");
  });
});
