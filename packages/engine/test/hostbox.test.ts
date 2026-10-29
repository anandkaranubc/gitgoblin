import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execShell } from "../src/exec.ts";
import { bwrapArgs, detectHostSandbox, hostSandboxFor, OFFLINE_ENV, sandboxExecProfile, specFor, trustedPath, type HostSandboxSpec } from "../src/hostbox.ts";

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
    expect(profile).toContain('(deny file-read* file-read-data (subpath "/home/x/.ssh"))');
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf('(allow file-write* (subpath "/ws"))'));
    expect(profile.indexOf('(allow file-write* (subpath "/ws"))')).toBeLessThan(profile.indexOf('(deny file-write* (subpath "/ws/.git"))'));
    expect(sandboxExecProfile({ workspace: "/ws", extraWrite: [], denyRead: [], network: true })).not.toContain("(deny network*)");
  });
  it("denies opening apps and sending them Apple events", () => {
    const profile = sandboxExecProfile({ workspace: "/ws", extraWrite: [], denyRead: [], network: false });
    expect(profile).toContain("(deny lsopen)");
    expect(profile).toContain("(deny appleevent-send)");
  });
  it("lets commands use Unix sockets only in their writable places", () => {
    const offline = sandboxExecProfile({ workspace: "/ws", extraWrite: ["/tmpdir"], denyRead: [], network: false });
    expect(offline).not.toMatch(/\(allow network-outbound \(remote unix-socket\)\)/);
    for (const dir of ["/ws", "/tmpdir"]) {
      expect(offline).toContain(`(allow network-bind network-inbound (local unix-socket (subpath "${dir}")))`);
      expect(offline).toContain(`(allow network-outbound (remote unix-socket (subpath "${dir}")))`);
    }
    const online = sandboxExecProfile({ workspace: "/ws", extraWrite: [], denyRead: [], network: true });
    expect(online).toContain("(deny network-outbound (remote unix-socket))");
    expect(online).toContain('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))');
    expect(online.indexOf("(deny network-outbound (remote unix-socket))")).toBeLessThan(online.indexOf('(allow network-outbound (remote unix-socket (subpath "/ws")))'));
  });
  it("escapes quotes and backslashes in paths", () => {
    expect(sandboxExecProfile({ workspace: '/w"s\\x', extraWrite: [], denyRead: [], network: false })).toContain('(subpath "/w\\"s\\\\x")');
  });
});

describe("bwrapArgs", () => {
  it("empties the directories that hold other programs' sockets before binding the workspace back", () => {
    const args = bwrapArgs({ workspace: "/tmp/run/ws", extraWrite: ["/tmp", "/home/u/.cache"], denyRead: [], network: false }, "true");
    const tmpfs = args.flatMap((a, i) => (a === "--tmpfs" ? [args[i + 1]] : []));
    for (const dir of ["/tmp", "/run", "/var/run"]) {
      let real = false;
      try {
        real = lstatSync(dir).isDirectory();
      } catch {}
      expect(tmpfs.includes(dir)).toBe(real);
    }
    // /tmp itself is the fresh tmpfs, never the host's /tmp bound back.
    expect(args.join(" ")).not.toContain("--bind /tmp /tmp");
    const firstBind = args.indexOf("--bind");
    for (let i = 0; i < args.length; i++) if (args[i] === "--tmpfs" && ["/tmp", "/run", "/var/run"].includes(args[i + 1]!)) expect(firstBind === -1 || i < firstBind).toBe(true);
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
    expect(profile.indexOf(`(deny file-read-data (subpath "${home}"))`)).toBeGreaterThan(-1);
    expect(profile.indexOf(`(deny file-read-data (subpath "${home}"))`)).toBeLessThan(profile.indexOf(`(allow file-read* file-read-data (subpath "${path.join(home, ".nvm")}"))`));
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
    // bubblewrap gives the sandbox its own empty /tmp, where the write may land; the host's stays untouched.
    await execShell("echo x > ../pwned", { cwd: ws, env, wrap: wrap(spec) });
    expect(existsSync(path.join(ws, "..", "pwned"))).toBe(false);
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

  it("keeps other programs' Unix sockets out of reach and lets commands use their own", async () => {
    const { root, ws, spec } = layout();
    // A socket outside the sandbox's writable places stands in for Docker's daemon or an SSH agent.
    const outside = path.join(root, "daemon.sock");
    const server = net.createServer((c) => c.end("SECRET-DAEMON"));
    await new Promise<void>((resolve) => server.listen(outside, resolve));
    try {
      const probe = (target: string) => `node -e "const c=require('net').connect('${target}');c.on('data',d=>console.log('got',String(d)));c.on('error',e=>console.log('refused',e.code))"`;
      for (const net_ of [false, true]) {
        const reach = await execShell(probe(outside), { cwd: ws, env, wrap: wrap({ ...spec, network: net_ }), timeoutMs: 20_000 });
        expect(reach.output).not.toContain("SECRET-DAEMON");
        expect(reach.output).toContain("refused");
      }
      const own = await execShell(
        `node -e "const net=require('net'),p=require('path').join(process.cwd(),'own.sock');const s=net.createServer(c=>c.end('mine')).listen(p,()=>net.connect(p).on('data',d=>{console.log('own',String(d));s.close()}).on('error',e=>console.log('own failed',e.code)))"`,
        { cwd: ws, env, wrap: wrap(spec), timeoutMs: 20_000 },
      );
      expect(own.output).toContain("own mine");
    } finally {
      server.close();
    }
  });

  it.skipIf(sandbox.kind !== "sandbox-exec")("cannot open apps, and local scripts still run", async () => {
    const { ws, spec } = layout();
    const open = await execShell("open -g /System/Library/CoreServices/Finder.app/Contents/Resources", { cwd: ws, env, wrap: wrap(spec), timeoutMs: 20_000 });
    expect(open.output).toMatch(/error -54|failed/);
    const local = await execShell(`osascript -e "return 2 + 2"`, { cwd: ws, env, wrap: wrap(spec), timeoutMs: 20_000 });
    expect(local.output.trim()).toBe("4");
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
    // macOS refuses the listing; bubblewrap shows an empty directory. Either way nothing private is visible.
    const listing = await run(`ls -a "${home}"`);
    expect(listing.output).not.toContain("Documents");
    // Tools resolve their own paths by looking up each folder above them (pnpm locks its store this
    // way), so metadata of the folders on the way to a carve-out stays visible; contents do not.
    mkdirSync(path.join(home, "Library", "pnpm", "store"), { recursive: true });
    const nested = specFor(ws, false, { home, strict: true });
    const resolve = await execShell(`node -e "console.log(require('fs').realpathSync('${path.join(home, "Library", "pnpm", "store")}'))"`, { cwd: ws, env, wrap: (c) => sandbox.wrap(c, nested) });
    expect(resolve.exitCode).toBe(0);
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

describe("trustedPath", () => {
  it("follows the system's own links and stops at one a user or a command made", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg-links-")));
    mkdirSync(path.join(root, "target"));
    symlinkSync(path.join(root, "target"), path.join(root, "cache"));
    expect(trustedPath(path.join(root, "cache"))).toBe(path.join(root, "cache"));
    expect(trustedPath(path.join(root, "cache", "deeper"))).toBe(path.join(root, "cache", "deeper"));
    expect(trustedPath(path.join(root, "target"))).toBe(path.join(root, "target"));
    // os.tmpdir() is reached through root-owned links on macOS (/var -> /private/var).
    expect(trustedPath(os.tmpdir())).toBe(realpathSync(os.tmpdir()));
    expect(specFor("/ws", false, { home: "/home/x", extraWrite: [path.join(root, "cache")] }).extraWrite).toContain(path.join(root, "cache"));
  });
});

describe.skipIf(!available)("writable folders swapped for links (OS)", () => {
  it("does not open a link's target to the next command", async () => {
    const { root, ws } = layout();
    const cache = path.join(realpathSync(root), "cache");
    const outside = path.join(realpathSync(root), "outside");
    const ownTmp = path.join(realpathSync(root), "own-tmp");
    for (const dir of [cache, outside, ownTmp]) mkdirSync(dir);
    // A spec rebuilt for every command, as the engine does, with the shared temp directory out of the way.
    const run = (command: string) => execShell(command, { cwd: ws, env, wrap: (c) => available!.wrap(c, specFor(ws, false, { extraWrite: [cache], tmpdir: ownTmp })), timeoutMs: 20_000 });
    expect((await run(`touch "${outside}/direct"`)).exitCode).not.toBe(0);
    // A command replaces the writable cache with a link to a folder it may not write; under bubblewrap
    // the bound folder cannot be removed at all.
    await run(`rm -rf "${cache}" && ln -s "${outside}" "${cache}"`);
    await run(`touch "${cache}/through-link"`);
    expect(existsSync(path.join(outside, "direct"))).toBe(false);
    expect(existsSync(path.join(outside, "through-link"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
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

describe("OFFLINE_ENV", () => {
  it("tells package managers the network is gone so they fail fast instead of retrying", () => {
    expect(OFFLINE_ENV).toMatchObject({ npm_config_offline: "true", YARN_ENABLE_NETWORK: "0", PIP_NO_INDEX: "1", UV_OFFLINE: "1", CARGO_NET_OFFLINE: "true", GOPROXY: "off" });
  });
});

describe.skipIf(!available)("offline checks (OS)", () => {
  it("makes npx fail in seconds when the package is not installed and the network is cut", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "gg-offline-"));
    writeFileSync(path.join(ws, "package.json"), "{}");
    const started = Date.now();
    const r = await execShell("npx --no-install definitely-not-a-real-package-gg", { cwd: ws, env: { ...env, ...OFFLINE_ENV }, wrap: (c) => available!.wrap(c, specFor(ws, false)), timeoutMs: 60_000 });
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

/** A terminal device this user can open outside any sandbox, if there is one. */
function openableTerminal(): string | undefined {
  for (const name of readdirSync("/dev").filter((d) => /^ttys\d+$/.test(d))) {
    try {
      closeSync(openSync(`/dev/${name}`, "r+"));
      return `/dev/${name}`;
    } catch {
      // not ours
    }
  }
  return undefined;
}

describe.skipIf(available?.kind !== "sandbox-exec" || !openableTerminal())("host sandbox and terminals (macOS)", () => {
  it("keeps repository commands away from the person's terminals", async () => {
    // A terminal device lets code type into or read from another tab: escape sequences that rewrite
    // the screen or set the clipboard, or keystrokes. Sandboxed commands run detached with no terminal.
    const tty = openableTerminal()!;
    const ws = mkdtempSync(path.join(os.tmpdir(), "gg-tty-"));
    const run = (command: string) => execShell(command, { cwd: ws, env, wrap: (c) => available!.wrap(c, specFor(ws, false)) });
    const write = await run(`printf '' > ${tty} && echo WROTE || echo refused`);
    expect(write.output).not.toContain("WROTE");
    const read = await run(`node -e "try { require('fs').openSync('${tty}', 'r'); console.log('OPENED') } catch (e) { console.log('refused', e.code) }"`);
    expect(read.output).not.toContain("OPENED");
    expect((await run("echo still works > out.txt && cat out.txt")).output).toContain("still works");
  });
});
