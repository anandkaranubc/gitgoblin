import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execShell } from "../src/exec.ts";
import { detectHostSandbox, specFor } from "../src/hostbox.ts";
import { looksLikePython, nodePackageManager, prepareToolchain } from "../src/toolchain.ts";
import { TaskSchema } from "../src/types.ts";

const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? os.tmpdir() };
const hasPython = (() => {
  try {
    return require("node:child_process").spawnSync("python3", ["-c", "import venv"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

function layout(files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-toolchain-"));
  const ws = path.join(root, "ws");
  mkdirSync(ws);
  for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(ws, rel), content);
  return { ws, runDir: path.join(root, "run") };
}

const task = (commands: Record<string, string>) => TaskSchema.parse({ id: "x", title: "t", repo: { owner: "o", name: "n" }, commands });

describe("looksLikePython", () => {
  it("recognises Python from the commands or the manifest files", () => {
    const { ws } = layout();
    expect(looksLikePython(task({ test: "pytest" }), ws)).toBe(true);
    expect(looksLikePython(task({ install: "pip install -e .[dev]" }), ws)).toBe(true);
    expect(looksLikePython(task({ test: "python -m unittest" }), ws)).toBe(true);
    expect(looksLikePython(task({ test: "npm test" }), ws)).toBe(false);
    expect(looksLikePython(task({}), layout({ "pyproject.toml": "[project]\nname='x'\n" }).ws)).toBe(true);
    expect(looksLikePython(task({}), layout({ "requirements.txt": "pytest\n" }).ws)).toBe(true);
    expect(looksLikePython(task({}), layout({ "package.json": "{}" }).ws)).toBe(false);
  });
});

describe("nodePackageManager", () => {
  it("reads the package manager from the manifest, the lockfile or the commands", () => {
    expect(nodePackageManager(task({ test: "pnpm test" }), layout({ "package.json": "{}" }).ws)).toBe("pnpm");
    expect(nodePackageManager(task({}), layout({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }) }).ws)).toBe("yarn");
    expect(nodePackageManager(task({}), layout({ "package.json": "{}", "pnpm-lock.yaml": "" }).ws)).toBe("pnpm");
    expect(nodePackageManager(task({}), layout({ "package.json": "{}", "bun.lock": "" }).ws)).toBe("bun");
    expect(nodePackageManager(task({}), layout({ "package.json": "{}", "package-lock.json": "{}" }).ws)).toBe("npm");
    expect(nodePackageManager(task({ test: "node --test" }), layout({ "package.json": "{}" }).ws)).toBe("npm");
    expect(nodePackageManager(task({ test: "pytest" }), layout({ "pyproject.toml": "" }).ws)).toBeUndefined();
  });
});

describe("prepareToolchain", () => {
  it("does nothing for projects that need nothing", async () => {
    const { ws, runDir } = layout({ "Makefile": "test:\n\ttrue\n" });
    const tc = await prepareToolchain(task({ test: "make test" }), ws, runDir, env);
    expect(tc.env).toEqual({});
    expect(tc.writeDirs).toEqual([]);
  });

  it("makes sure the Node package manager's home and caches exist so the sandbox can allow writes to them", async () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg-home-")));
    const { ws, runDir } = layout({ "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }), "pnpm-lock.yaml": "" });
    const tc = await prepareToolchain(task({ install: "pnpm install", test: "pnpm test" }), ws, runDir, env, { home });
    const pnpmHome = process.platform === "darwin" ? path.join(home, "Library", "pnpm") : path.join(home, ".local", "share", "pnpm");
    expect(existsSync(pnpmHome)).toBe(true);
    expect(existsSync(path.join(home, ".cache", "node", "corepack"))).toBe(true);
    expect(tc.notes.join(" ")).toMatch(/node: pnpm/);
    // Nothing of the engine's own was created inside the user's home beyond those directories.
    expect(tc.writeDirs).toEqual([]);
    const spec = specFor(ws, true, { home });
    expect(spec.extraWrite).toContain(pnpmHome);
    const corepack = path.join(home, ".cache", "node", "corepack");
    expect(spec.extraWrite.some((dir) => corepack === dir || corepack.startsWith(dir + path.sep))).toBe(true);
  });

  it("prepares npm, yarn and bun caches likewise", async () => {
    for (const [pm, files] of [["npm", { "package-lock.json": "{}" }], ["yarn", { "yarn.lock": "" }], ["bun", { "bun.lockb": "" }]] as const) {
      const home = mkdtempSync(path.join(os.tmpdir(), "gg-home-"));
      const { ws, runDir } = layout({ "package.json": "{}", ...files });
      const tc = await prepareToolchain(task({ test: `${pm} test` }), ws, runDir, env, { home });
      expect(tc.notes.join(" ")).toContain(`node: ${pm}`);
      const expected = { npm: [".npm"], yarn: [process.platform === "darwin" ? "Library/Caches/Yarn" : ".cache/yarn", ".yarn"], bun: [".bun/install/cache"] }[pm];
      for (const rel of expected) expect(existsSync(path.join(home, rel))).toBe(true);
    }
  });

  it("points bundler at a per-run gem path", async () => {
    const { ws, runDir } = layout({ Gemfile: "source 'https://rubygems.org'\n" });
    const tc = await prepareToolchain(task({ test: "bundle exec rspec" }), ws, runDir, env);
    expect(tc.env["BUNDLE_PATH"]).toBe(path.join(realpathSync(runDir), "toolchain", "bundle"));
    expect(tc.writeDirs).toContain(path.join(realpathSync(runDir), "toolchain"));
  });

  it.skipIf(!hasPython)("creates a virtualenv for Python projects and puts it first on PATH", async () => {
    const { ws, runDir } = layout({ "pyproject.toml": "[project]\nname='x'\nversion='0'\n" });
    const tc = await prepareToolchain(task({ install: "pip install -e .", test: "pytest" }), ws, runDir, env);
    const venv = path.join(realpathSync(runDir), "toolchain", "venv");
    expect(tc.env["VIRTUAL_ENV"]).toBe(venv);
    expect(tc.env["PATH"]?.startsWith(path.join(venv, "bin") + path.delimiter)).toBe(true);
    expect(existsSync(path.join(venv, "bin", "python"))).toBe(true);
    const which = await execShell("python -c 'import sys; print(sys.prefix)'", { cwd: ws, env: { ...env, ...tc.env } });
    expect(which.output.trim()).toBe(venv);
  }, 60_000);

  it.skipIf(!hasPython || !detectHostSandbox())("lets installs write into the virtualenv but not into the system interpreter", async () => {
    const { ws, runDir } = layout({ "pyproject.toml": "[project]\nname='x'\nversion='0'\n" });
    const tc = await prepareToolchain(task({ install: "pip install -e .", test: "pytest" }), ws, runDir, env);
    const sandbox = detectHostSandbox()!;
    const spec = specFor(ws, false, { extraWrite: tc.writeDirs });
    const run = (command: string) => execShell(command, { cwd: ws, env: { ...env, ...tc.env }, wrap: (c) => sandbox.wrap(c, spec), timeoutMs: 60_000 });
    const inside = await run(`python -c "import sysconfig, pathlib; p = pathlib.Path(sysconfig.get_paths()['purelib']) / 'gg_probe.txt'; p.write_text('x'); print('wrote', p)"`);
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toContain(path.join(realpathSync(runDir), "toolchain", "venv"));
    const outside = await run(`python -c "import sysconfig, pathlib, sys; base = pathlib.Path(sysconfig.get_paths(vars={'base': sys.base_prefix, 'platbase': sys.base_prefix})['purelib']) / 'gg_probe.txt'; base.write_text('x')"`);
    expect(outside.exitCode).not.toBe(0);
  }, 60_000);
});
