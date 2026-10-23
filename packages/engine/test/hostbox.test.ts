import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execShell } from "../src/exec.ts";
import { detectHostSandbox, hostSandboxFor, sandboxExecProfile, specFor, type HostSandboxSpec } from "../src/hostbox.ts";

const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? os.tmpdir() };
const available = detectHostSandbox();

function layout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-hostbox-"));
  const ws = path.join(root, "ws");
  mkdirSync(path.join(ws, ".git"), { recursive: true });
  mkdirSync(path.join(root, "secrets"));
  writeFileSync(path.join(root, "secrets", "id_rsa"), "PRIVATE");
  writeFileSync(path.join(ws, "a.txt"), "a");
  return { root, ws, spec: { workspace: ws, extraWrite: [], denyRead: [path.join(root, "secrets")], network: false } satisfies HostSandboxSpec };
}

describe("sandboxExecProfile", () => {
  it("denies by default and allows only the listed paths, never .git", () => {
    const profile = sandboxExecProfile({ workspace: "/ws", extraWrite: ["/caches"], denyRead: ["/home/x/.ssh"], network: false });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/ws"))');
    expect(profile).toContain('(allow file-write* (subpath "/caches"))');
    expect(profile).toContain('(deny file-write* (subpath "/ws/.git"))');
    expect(profile).toContain('(deny file-read* (subpath "/home/x/.ssh"))');
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf('(allow file-write* (subpath "/ws"))'));
    expect(profile.indexOf('(allow file-write* (subpath "/ws"))')).toBeLessThan(profile.indexOf('(deny file-write* (subpath "/ws/.git"))'));
    expect(sandboxExecProfile({ workspace: "/ws", extraWrite: [], denyRead: [], network: true })).not.toContain("(deny network*)");
  });
  it("escapes quotes and backslashes in paths", () => {
    expect(sandboxExecProfile({ workspace: '/w"s\\x', extraWrite: [], denyRead: [], network: false })).toContain('(subpath "/w\\"s\\\\x")');
  });
});

describe("hostSandboxFor", () => {
  it("falls back to no isolation when nothing is available and the caller allows it", () => {
    expect(hostSandboxFor("none", () => undefined)).toEqual({ kind: "none" });
    expect(hostSandboxFor("auto", () => undefined)).toEqual({ kind: "none" });
    expect(() => hostSandboxFor("sandbox", () => undefined)).toThrow(/no OS sandbox/);
    expect(() => hostSandboxFor("strict", () => undefined)).toThrow(/no OS sandbox/);
  });
});

describe("specFor strict mode", () => {
  it("hides the home directory except toolchain and cache directories, the run prefix and the temp dir", () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg-home-")));
    mkdirSync(path.join(home, ".nvm"));
    mkdirSync(path.join(home, ".npm"));
    mkdirSync(path.join(home, "Documents"));
    const runPrefix = path.join(home, "project", ".gitgoblin", "runs", "x", "toolchain");
    const spec = specFor("/ws", false, { home, strict: true, extraWrite: ["/run/toolchain", runPrefix] });
    expect(spec.denyRead).toContain(home);
    // Only paths under the home directory need carving back out; the run prefix under it does, one elsewhere does not.
    expect(spec.allowRead).toEqual(expect.arrayContaining([path.join(home, ".nvm"), path.join(home, ".npm"), runPrefix]));
    expect(spec.allowRead).not.toContain("/run/toolchain");
    expect(spec.allowRead).not.toContain(path.join(home, "Documents"));
    expect(spec.allowRead).not.toContain(home);
    const profile = sandboxExecProfile(spec);
    expect(profile.indexOf(`(deny file-read* (subpath "${home}"))`)).toBeGreaterThan(-1);
    expect(profile.indexOf(`(deny file-read* (subpath "${home}"))`)).toBeLessThan(profile.indexOf(`(allow file-read* (subpath "${path.join(home, ".nvm")}"))`));
    // Credential paths are denied again after the allows, so ~/.npm/.npmrc-style secrets stay hidden.
    expect(profile.lastIndexOf("(deny file-read*")).toBeGreaterThan(profile.lastIndexOf("(allow file-read*"));
    const relaxed = specFor("/ws", false, { home });
    expect(relaxed.denyRead).not.toContain(home);
    expect(relaxed.allowRead ?? []).toEqual([]);
  });
});

describe.skipIf(!available)("host sandbox (OS)", () => {
  const sandbox = available!;
  const wrap = (spec: HostSandboxSpec) => (command: string) => sandbox.wrap(command, spec);

  it("lets repository commands write the workspace but not .git, the parent or the home directory", async () => {
    const { ws, spec } = layout();
    const inside = await execShell("echo hi > a.txt && cat a.txt", { cwd: ws, env, wrap: wrap(spec) });
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toContain("hi");
    const git = await execShell("echo x > .git/pwned", { cwd: ws, env, wrap: wrap(spec) });
    expect(git.exitCode).not.toBe(0);
    expect(existsSync(path.join(ws, ".git", "pwned"))).toBe(false);
    const parent = await execShell("echo x > ../pwned", { cwd: ws, env, wrap: wrap(spec) });
    expect(parent.exitCode).not.toBe(0);
    const home = await execShell(`echo x > "$HOME/gg-hostbox-pwned"`, { cwd: ws, env, wrap: wrap(spec) });
    expect(home.exitCode).not.toBe(0);
    expect(existsSync(path.join(env.HOME, "gg-hostbox-pwned"))).toBe(false);
  });

  it("hides credential paths and cuts the network while keeping localhost", async () => {
    const { root, ws, spec } = layout();
    const secret = await execShell(`cat "${path.join(root, "secrets", "id_rsa")}"`, { cwd: ws, env, wrap: wrap(spec) });
    expect(secret.output).not.toContain("PRIVATE");
    const net = await execShell(`node -e "fetch('https://example.com').then(()=>console.log('REACHED')).catch(e=>console.log('blocked', e.cause?.code||e.message))"`, { cwd: ws, env, wrap: wrap(spec), timeoutMs: 20_000 });
    expect(net.output).not.toContain("REACHED");
    expect(net.output).toContain("blocked");
    const local = await execShell(
      `node -e "const h=require('http');const s=h.createServer((q,r)=>r.end('pong')).listen(0,'127.0.0.1',()=>h.get('http://127.0.0.1:'+s.address().port,r=>{let b='';r.on('data',d=>b+=d).on('end',()=>{console.log('local',b);s.close()})}))"`,
      { cwd: ws, env, wrap: wrap(spec), timeoutMs: 20_000 },
    );
    expect(local.output).toContain("local pong");
  });

  it("runs the tool chain and lets the install phase reach the network", async () => {
    const { ws, spec } = layout();
    writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('tests ok')\"" } }));
    const test = await execShell("npm test", { cwd: ws, env, wrap: wrap(spec), timeoutMs: 60_000 });
    expect(test.exitCode).toBe(0);
    expect(test.output).toContain("tests ok");
    const dns = await execShell(`node -e "require('dns').promises.lookup('localhost').then(()=>console.log('resolved'))"`, { cwd: ws, env, wrap: wrap({ ...spec, network: true }), timeoutMs: 20_000 });
    expect(dns.output).toContain("resolved");
  });
});

describe.skipIf(!available)("host sandbox strict mode (OS)", () => {
  const sandbox = available!;
  it("lets commands read toolchains under a home directory but nothing else in it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "gg-strict-"));
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(path.join(home, ".nvm"), { recursive: true });
    mkdirSync(path.join(home, "Documents"), { recursive: true });
    mkdirSync(ws);
    writeFileSync(path.join(home, ".nvm", "version.txt"), "v24");
    writeFileSync(path.join(home, "Documents", "taxes.txt"), "PRIVATE");
    const spec = specFor(ws, false, { home, strict: true });
    const run = (command: string) => execShell(command, { cwd: ws, env, wrap: (c) => sandbox.wrap(c, spec) });
    const toolchain = await run(`cat "${path.join(home, ".nvm", "version.txt")}"`);
    expect(toolchain.output).toContain("v24");
    const documents = await run(`cat "${path.join(home, "Documents", "taxes.txt")}"`);
    expect(documents.output).not.toContain("PRIVATE");
    expect(documents.exitCode).not.toBe(0);
    const listing = await run(`ls "${home}"`);
    expect(listing.exitCode).not.toBe(0);
  });
});

describe("specFor paths", () => {
  it("returns real paths, so a profile built from it matches what the kernel checks", () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "gg-real-"));
    const spec = specFor(ws, false);
    expect(spec.workspace).toBe(realpathSync(ws));
    expect(spec.extraWrite).toContain(realpathSync(os.tmpdir()));
  });
  it("lets tools use the shared /tmp as well as the per-user temp directory", () => {
    const spec = specFor(mkdtempSync(path.join(os.tmpdir(), "gg-real-")), false);
    if (existsSync("/tmp")) expect(spec.extraWrite).toContain(realpathSync("/tmp"));
  });
});

describe.skipIf(!available)("host sandbox temp directories (OS)", () => {
  it("allows writes to $TMPDIR and /tmp, also when the profile is built from specFor directly", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "gg-tmp-"));
    const spec = specFor(ws, false);
    const viaWrap = (command: string) => execShell(command, { cwd: ws, env, wrap: (c) => available!.wrap(c, spec) });
    expect((await viaWrap('touch "$TMPDIR/gg-tmp-probe" && rm "$TMPDIR/gg-tmp-probe"')).exitCode).toBe(0);
    expect((await viaWrap("touch /tmp/gg-tmp-probe-$$ && rm /tmp/gg-tmp-probe-$$")).exitCode).toBe(0);
    if (available!.kind === "sandbox-exec") {
      const direct = await execShell('touch "$TMPDIR/gg-tmp-direct" && rm "$TMPDIR/gg-tmp-direct"', {
        cwd: ws,
        env,
        wrap: (c) => ({ file: "/usr/bin/sandbox-exec", args: ["-p", sandboxExecProfile(spec), "/bin/sh", "-c", c] }),
      });
      expect(direct.exitCode).toBe(0);
    }
  });
});
