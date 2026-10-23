import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An OS sandbox for the repository's own commands (install, test, lint, build), which run on the
 * operator's machine after the agent has edited the tree. The Agent SDK sandbox covers only the
 * agent's shell; this covers the engine's. macOS uses the system `sandbox-exec`, Linux uses
 * bubblewrap when it is installed. Writes are limited to the workspace (never its `.git`), the
 * temp directory and tool caches; credential paths are unreadable; the network is off except on
 * localhost, and on for the install phase only.
 */

/**
 * "auto": OS sandbox when available, else bare with a warning. "sandbox": required. "strict": required,
 * and the operator's home directory is unreadable except for toolchain and cache directories, the
 * temp directory and the run's own prefix. "none": bare.
 */
export type CheckIsolation = "auto" | "sandbox" | "strict" | "none";

export interface HostSandboxSpec {
  workspace: string;
  /** Further writable directories, for example tool caches under the home directory. */
  extraWrite: string[];
  denyRead: string[];
  /** Carved back out of `denyRead`, in order: a denied parent with allowed children. Credential paths win last. */
  allowRead?: string[];
  network: boolean;
}

export interface WrappedCommand {
  file: string;
  args: string[];
}

export interface HostSandbox {
  kind: "sandbox-exec" | "bwrap";
  /** Turns a shell command line into an argv that runs it inside the sandbox. */
  wrap(command: string, spec: HostSandboxSpec): WrappedCommand;
}

export type HostIsolation = HostSandbox | { kind: "none" };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The kernel matches sandbox rules against real paths, so `/var/folders/...` must become `/private/var/folders/...`. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function realSpec(spec: HostSandboxSpec): HostSandboxSpec {
  return { ...spec, workspace: real(spec.workspace), extraWrite: spec.extraWrite.map(real), denyRead: spec.denyRead.map(real), ...(spec.allowRead ? { allowRead: spec.allowRead.map(real) } : {}) };
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The OS sandbox this machine offers, if any. */
export function detectHostSandbox(): HostSandbox | undefined {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    return { kind: "sandbox-exec", wrap: (command, spec) => ({ file: SANDBOX_EXEC, args: ["-p", sandboxExecProfile(realSpec(spec)), "/bin/sh", "-c", command] }) };
  }
  if (process.platform === "linux") {
    const bwrap = onPath("bwrap");
    if (bwrap) return { kind: "bwrap", wrap: (command, spec) => ({ file: bwrap, args: bwrapArgs(realSpec(spec), command) }) };
  }
  return undefined;
}

/** Resolves the operator's choice against what the machine offers. */
export function hostSandboxFor(isolation: CheckIsolation, detect: () => HostSandbox | undefined = detectHostSandbox): HostIsolation {
  if (isolation === "none") return { kind: "none" };
  const found = detect();
  if (found) return found;
  if (isolation === "sandbox" || isolation === "strict") {
    throw new Error("no OS sandbox is available for repository commands on this machine (macOS: sandbox-exec; Linux: bwrap). Install bubblewrap, run the engine in a container, or pass checkIsolation \"none\" knowingly.");
  }
  return { kind: "none" };
}

/** Credential locations under the home directory that repository commands never need to read. */
export const CREDENTIAL_PATHS = [
  ".ssh", ".aws", ".azure", ".gnupg", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".docker", ".kube", ".terraform.d",
  ".config/gh", ".config/gcloud", ".config/hub", ".cargo/credentials", ".cargo/credentials.toml", ".claude/.credentials.json", ".claude.json",
  "Library/Keychains", ".password-store", ".local/share/keyrings",
];

/** Tool caches under the home directory that package managers and compilers write to. */
const CACHE_DIRS = [
  ".npm", ".cache", ".pnpm-store", ".pnpm-state", ".local/share/pnpm", "Library/pnpm", "Library/Caches/Yarn", ".yarn/berry/cache", ".yarn/cache", ".yarn", ".bun/install/cache", ".deno",
  ".cargo/registry", ".cargo/git", ".cargo/.package-cache", ".rustup/tmp", ".rustup/downloads", "go/pkg", ".m2/repository", ".gradle",
  ".local/share/uv", ".local/share/virtualenvs", ".gem", ".bundle/cache", ".nuget/packages", ".dotnet", ".composer/cache", ".mix", ".hex",
  ".julia", ".swiftpm", ".ivy2", ".sbt", "Library/Caches",
];

/** Where language toolchains live under a home directory; readable in strict mode so builds still find their compilers. */
const TOOLCHAIN_DIRS = [
  ".nvm", ".volta", ".fnm", ".n", ".asdf", ".pyenv", ".rbenv", ".goenv", ".jenv", ".sdkman", ".rustup", ".cargo", ".local", ".poetry", ".pixi", ".conda",
  "miniconda3", "anaconda3", "go", ".bun", ".deno", ".yarn", ".pnpm", ".nuget", ".dotnet", ".gem", ".rvm", ".m2", ".gradle", ".ivy2", ".sbt", ".swiftpm",
  ".config/nvm", ".config/pip", ".config/uv", ".config/git", ".gitconfig", ".npmrc.d", ".bashrc", ".zshrc", ".profile",
];

export interface SpecOptions {
  /** Further writable directories, for example the run's toolchain prefix. */
  extraWrite?: string[];
  /** Hide the home directory except toolchains, caches, the temp dir and the extras. */
  strict?: boolean;
  home?: string;
  tmpdir?: string;
}

/** The spec for commands in `workspace`: temp dir, tool caches and the given extras writable, credential paths hidden. */
export function specFor(workspace: string, network: boolean, options: SpecOptions = {}): HostSandboxSpec {
  return dedupe(realSpec(buildSpec(workspace, network, options)));
}

function dedupe(spec: HostSandboxSpec): HostSandboxSpec {
  return { ...spec, extraWrite: [...new Set(spec.extraWrite)], ...(spec.allowRead ? { allowRead: [...new Set(spec.allowRead)] } : {}) };
}

/**
 * The per-user temp directory and the shared /tmp are both writable: tools differ in which they use
 * (pnpm takes its store lock under /tmp), and on macOS /tmp is /private/tmp, which only a real-path
 * rule matches.
 */
function buildSpec(workspace: string, network: boolean, options: SpecOptions): HostSandboxSpec {
  const home = options.home ?? os.homedir();
  const tmpdir = options.tmpdir ?? os.tmpdir();
  const existing = (rels: string[]) => rels.map((rel) => path.join(home, rel)).filter((p) => existsSync(p));
  const systemTmp = existsSync("/tmp") ? ["/tmp"] : [];
  const extraWrite = [tmpdir, ...systemTmp, ...(options.extraWrite ?? []), ...existing(CACHE_DIRS)];
  const credentials = CREDENTIAL_PATHS.map((rel) => path.join(home, rel));
  if (!options.strict) return { workspace, extraWrite, denyRead: credentials, network };
  // The running node binary may itself live under the home directory (nvm, volta, fnm).
  const nodeHome = path.dirname(path.dirname(process.execPath));
  // Only paths under the home directory need carving out; everything else was never denied.
  const underHome = (p: string) => p === home || p.startsWith(home + path.sep);
  const allowRead = [...new Set([...existing(TOOLCHAIN_DIRS), ...existing(CACHE_DIRS), ...extraWrite, workspace, nodeHome].filter(underHome).filter((p) => p !== home))];
  return { workspace, extraWrite, denyRead: [home, ...credentials], allowRead, network };
}

function sbpl(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Apple's sandbox profile language; the last matching rule wins, so the profile denies broadly and
 * then allows the few places a build may write, ending with the `.git` directory denied again.
 */
export function sandboxExecProfile(spec: HostSandboxSpec): string {
  const lines = ["(version 1)", "(allow default)"];
  if (!spec.network) {
    lines.push(
      "(deny network*)",
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-outbound (remote unix-socket))',
    );
  }
  lines.push("(deny file-write*)");
  for (const dir of [spec.workspace, ...spec.extraWrite]) lines.push(`(allow file-write* (subpath ${sbpl(dir)}))`);
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))',
    '(allow file-write* (regex #"^/dev/fd/") (regex #"^/dev/ttys") (regex #"^/dev/pty") (regex #"^/private/var/run/"))',
    `(deny file-write* (subpath ${sbpl(path.join(spec.workspace, ".git"))}))`,
  );
  // Order matters (last match wins): deny the home directory, allow the toolchains back, then deny
  // credential paths again so an allowed parent cannot expose them.
  const home = spec.allowRead ? spec.denyRead[0] : undefined;
  const credentials = spec.allowRead ? spec.denyRead.slice(1) : spec.denyRead;
  if (home) lines.push(`(deny file-read* (subpath ${sbpl(home)}))`);
  for (const p of spec.allowRead ?? []) lines.push(`(allow file-read* (subpath ${sbpl(p)}))`);
  for (const p of credentials) lines.push(`(deny file-read* (subpath ${sbpl(p)}))`);
  return lines.join("\n") + "\n";
}

/** bubblewrap: the whole filesystem read-only, the allowed places bound writable, credentials masked, no network namespace. */
export function bwrapArgs(spec: HostSandboxSpec, command: string): string[] {
  const args = ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  if (!spec.network) args.push("--unshare-net");
  for (const dir of [spec.workspace, ...spec.extraWrite]) if (existsSync(dir)) args.push("--bind", dir, dir);
  const gitDir = path.join(spec.workspace, ".git");
  if (existsSync(gitDir)) args.push("--ro-bind", gitDir, gitDir);
  const hide = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) args.push("--tmpfs", p);
    else args.push("--ro-bind", "/dev/null", p);
  };
  // Mounts apply in order: an empty tmpfs over the home directory, the toolchains bound back (read-only
  // unless also writable), then credential paths hidden again.
  const home = spec.allowRead ? spec.denyRead[0] : undefined;
  const credentials = spec.allowRead ? spec.denyRead.slice(1) : spec.denyRead;
  if (home) {
    hide(home);
    for (const p of spec.allowRead ?? []) {
      if (!existsSync(p) || !p.startsWith(home + path.sep)) continue;
      args.push(spec.extraWrite.includes(p) || spec.workspace === p ? "--bind" : "--ro-bind", p, p);
    }
  }
  for (const p of credentials) hide(p);
  args.push("--chdir", spec.workspace, "--", "/bin/sh", "-c", command);
  return args;
}
