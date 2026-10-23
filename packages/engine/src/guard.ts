import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookCallback, Options, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { specFor } from "./hostbox.ts";
import { isProtectedPath } from "./policy.ts";
import type { Task } from "./types.ts";

/**
 * Security boundaries for agent sessions. Hooks are best-effort text matching that fails closed on
 * known-dangerous shapes; the Agent SDK sandbox (filesystem and network) is the hard boundary.
 */

export type ToolProfile = "build" | "review";

export interface GuardContext {
  workspace: string;
  task: Pick<Task, "kind">;
  profile: ToolProfile;
  /** Extra directories the agent may read, in addition to the workspace. */
  readRoots?: string[];
  onDeny?: (toolName: string, reason: string) => void;
}

interface DenyRule {
  pattern: RegExp;
  reason: string;
}

/** Options that may sit between `git` and its subcommand, e.g. `git -C . push`. */
const GIT_OPTS = String.raw`(?:(?:-[cC]\s+\S+|--git-dir=\S+|--work-tree=\S+|-\S+)\s+)*`;
const NETWORK_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp"]);
/** Container, orchestration and host-administration tools, plus the macOS keychain and preferences CLIs. */
const SYSTEM_TOOLS = new Set([
  "docker", "podman", "kubectl", "helm", "terraform", "crontab", "launchctl", "systemctl", "osascript",
  "security", "defaults", "dscl", "diskutil", "csrutil", "spctl", "nvram", "pmset", "scutil", "networksetup", "softwareupdate", "tmutil",
]);
const WRAPPERS = new Set(["env", "nohup", "time", "xargs", "exec", "command", "nice", "sh", "bash", "zsh", "-c"]);

/** The program each shell segment would run: `A=1 env curl x | grep curl` gives ["curl", "grep"]. */
export function commandNames(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\$\(|`|\(|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))) i += 1;
    const name = tokens[i]?.replace(/^["']+/, "");
    if (name) names.push(path.basename(name));
  }
  return names;
}

const BASH_DENY_RULES: DenyRule[] = [
  { pattern: new RegExp(String.raw`\bgit\s+${GIT_OPTS}push\b`), reason: "git push happens in the engine after human approval" },
  {
    pattern: new RegExp(String.raw`\bgit\s+${GIT_OPTS}(remote|config|update-ref|symbolic-ref|reflog|gc|prune|filter-branch|replace|worktree)\b`),
    reason: "git configuration, refs and remotes are managed by the engine",
  },
  { pattern: new RegExp(String.raw`\bgit\s+${GIT_OPTS}branch\s+(?:\S+\s+)*-[a-zA-Z]*[fFdDmM]`), reason: "branches are managed by the engine" },
  { pattern: new RegExp(String.raw`\bgit\s+${GIT_OPTS}(fetch|pull|clone|submodule\s+update)\b`), reason: "the agent has no network access" },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\btwine\b|\bcargo\s+publish\b|\bgem\s+push\b|\bgoreleaser\b/,
    reason: "publishing is not part of a contribution",
  },
  { pattern: /\b(sudo|doas)\b|(^|[\s;&|])su\s/, reason: "privilege escalation is disabled" },
  { pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME)\/?(\s|$)/, reason: "destructive delete outside the workspace" },
  { pattern: /\b(chmod|chown)\s+(-R\s+)?\S+\s+(\/|~)(\s|$)/, reason: "permission changes outside the workspace" },
];

const PACKAGE_INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(.*)$|\b(?:pip3?|uv)\s+(?:pip\s+)?(?:install|add)\s+(.*)$/;

/** Drops `2>&1`, `>log`, `> log`, `</dev/null`: redirections and their targets are not package names. */
function withoutRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (/^\d*(>>?|<|&>>?)(&\d+)?$/.test(token)) {
      i += 1; // bare operator: the next token is its target
      continue;
    }
    if (/^\d*(>>?|<|&>>?)/.test(token)) continue; // operator with the target attached
    out.push(token);
  }
  return out;
}

/** True when a command would add a package that is not already declared by the repository. */
export function installsNewPackage(command: string): boolean {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const m = PACKAGE_INSTALL.exec(segment.trim());
    if (!m) continue;
    const args = withoutRedirections((m[1] ?? m[2] ?? "").trim().split(/\s+/).filter(Boolean));
    if (args.some((a) => /^(-r|--requirement|-e|--editable|\.|\.\/)/.test(a))) continue;
    if (args.some((a) => !a.startsWith("-"))) return true;
  }
  return false;
}

export function bashDenyReason(command: string): string | null {
  for (const rule of BASH_DENY_RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  const names = commandNames(command);
  if (names.includes("gh")) return "GitHub writes happen in the engine after human approval";
  if (names.some((n) => NETWORK_TOOLS.has(n))) return "network tools are disabled";
  if (names.some((n) => SYSTEM_TOOLS.has(n))) return "system and infrastructure tools are disabled";
  if (installsNewPackage(command)) return "adding packages is a maintainer decision; name the dependency in your output instead. The repository's own dependencies were installed by the engine before this session (see install-output.txt in the run directory)";
  return null;
}

const READ_ONLY_COMMANDS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "rg", "find", "tree", "pwd", "echo", "diff", "sort", "uniq", "cut", "jq", "stat", "file",
]);
const READ_ONLY_GIT = /^git\s+(diff|log|show|status|blame|ls-files|grep|rev-parse)\b/;

/** Reviewers may only run read-only commands. The review sandbox also denies workspace writes. */
export function reviewerBashDenyReason(command: string): string | null {
  const general = bashDenyReason(command);
  if (general) return general;
  if (/[<>`$]|\n/.test(command)) return "reviewers run plain read-only commands; redirection and substitution are not allowed";
  for (const raw of command.split(/&&|\|\||;|\|/)) {
    const segment = raw.trim();
    if (!segment) continue;
    if (READ_ONLY_GIT.test(segment)) continue;
    if (/^sed\s+-n\b/.test(segment)) continue;
    const name = segment.split(/\s+/)[0] ?? "";
    if (READ_ONLY_COMMANDS.has(name)) continue;
    return `reviewers run read-only commands; "${name}" is not one`;
  }
  return null;
}

const KNOWN_RUNNERS =
  /^(npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|uv|poetry|tox|nox|hatch|cargo|go|make|mvn|gradle|\.\/gradlew|dotnet|bundle|rake|rspec|mix|swift|zig|ruff|black|mypy|flake8|pylint|eslint|prettier|tsc|vitest|jest|mocha|ctest|cmake|meson|ninja|bazel|sbt|composer|phpunit|php|ruby|julia|Rscript|just)$/;

/**
 * Per runner, the arguments that turn a check command into something else: inline code, preloaded
 * files, other manifests or directories, installs, and download-and-run forms. Matched against every
 * argument, so a flag after `--` still counts; a false positive only means the engine keeps the
 * command intel already knew.
 */
const RUNNER_DENY: Record<string, RegExp> = {
  node: /^(-e|--eval|-p|--print|-i|--interactive|-r|--require|--import|--loader|--experimental-loader|--experimental-default-type|-c|--check)(=|$)/,
  deno: /^(eval|repl|install|uninstall|upgrade|compile|add|remove|publish)$/,
  bun: /^(-e|--eval|-p|--print|-r|--preload|--require|--import|x|install|i|add|remove|rm|create|init|upgrade|pm|publish|link|update)$/,
  python: /^(-(?!-)[A-Za-z]*[ci][A-Za-z]*)$/,
  python3: /^(-(?!-)[A-Za-z]*[ci][A-Za-z]*)$/,
  ruby: /^(-(?!-)[A-Za-z]*[er][A-Za-z]*)(=|$)/,
  php: /^(-r|-R|-B|-E|-F|-a|-d)$/,
  npx: /^(-y|--yes|-p|--package|-c|--call|--ignore-existing)(=|$)/,
  npm: /^(exec|x|it|install-test|install-ci-test|cit|ci|install|i|update|up|link|ln|publish|dedupe|ddp|prune|rebuild|rb|--prefix|-C|--userconfig|--globalconfig|--script-shell|--cache|--workspace|-w)(=|$)/,
  pnpm: /^(dlx|install|i|add|update|up|publish|link|import|--dir|-C|--prefix|--filter|-F)(=|$)/,
  yarn: /^(dlx|install|add|up|upgrade|publish|link|--cwd|--modules-folder)(=|$)/,
  uv: /^(tool|pip|add|remove|publish|sync|lock|venv|--with|--with-requirements|--with-editable|--project|--directory|-s|--script)(=|$)/,
  poetry: /^(add|remove|install|update|publish|lock|self|--directory|-C)(=|$)/,
  make: /^(-f|--file|--makefile|-C|--directory|-I|--include-dir|-E|--eval)(=|$)/,
  cargo: /^(--manifest-path|install|publish|add|remove|update|fetch|--config|-Z)(=|$)/,
  go: /^(-C|get|install|env|generate)$/,
  mvn: /^(-f|--file|-s|--settings|-gs|--global-settings|-t|--toolchains|deploy|install)$/,
  gradle: /^(-b|--build-file|-c|--settings-file|-p|--project-dir|-I|--init-script)(=|$)/,
  gradlew: /^(-b|--build-file|-c|--settings-file|-p|--project-dir|-I|--init-script)(=|$)/,
  dotnet: /^(tool|nuget|add|remove|new|workload|--project|-p)(=|$)/,
  bundle: /^(install|add|update|config|gem|plugin)$/,
  composer: /^(install|update|require|remove|global|create-project|config|self-update)$/,
  mix: /^(run|-e|--eval|deps\.get|deps\.update|archive\.install|escript\.install|local\.hex|local\.rebar|hex\.\S*)$/,
  swift: /^(-e|package|-I|-F|-L)$/,
  julia: /^(-e|--eval|-E|--print|-L|--load|-J|--sysimage)(=|$)/,
  Rscript: /^(-e|--default-packages)(=|$)/,
  just: /^(--justfile|-f|--working-directory|-d|--command|-c|--eval|--shell|--shell-arg)(=|$)/,
  tox: /^(-c|--conf|--root|--workdir)(=|$)/,
  nox: /^(-f|--noxfile)(=|$)/,
  hatch: /^(-C|--config|--project|-p|python|env|publish)(=|$)/,
  pytest: /^(-c|--config-file|--rootdir|--pythonpath|--confcutdir)(=|$)/,
  cmake: /^(-P|-E|--preset|--toolchain)(=|$)/,
  bazel: /^(--bazelrc|--override_repository|--override_module|--registry|--repository_cache|--output_base|--output_user_root)(=|$)/,
  eslint: /^(-c|--config|--rulesdir|--plugin|--resolve-plugins-relative-to|--parser)(=|$)/,
  prettier: /^(--config|--plugin|--plugin-search-dir)(=|$)/,
  vitest: /^(-c|--config|-r|--root|--dir|--setupFiles|--globalSetup)(=|$)/,
  jest: /^(-c|--config|--rootDir|--setupFiles|--setupFilesAfterEach|--globalSetup|--globalTeardown|--preset|--testEnvironment|--transform)(=|$)/,
  mocha: /^(-r|--require|-n|--node-option|--config|--file|--package)(=|$)/,
};
/** `python -m <module>` forms that install or run arbitrary code rather than the project's tests. */
const PYTHON_MODULE_DENY = /^(pip|pipx|ensurepip|venv|uv|http\.server|code|pdb|idlelib|webbrowser)$/;

function hasPathOutsideWorkspace(token: string): boolean {
  const value = token.replace(/^--?[A-Za-z][\w-]*=/, "");
  if (value.startsWith("/") || value.startsWith("~") || /:\/\//.test(value)) return true;
  return value.split(/[\\/]/).includes("..");
}

/**
 * Commands the model discovers during orientation run on the host, outside the sandbox, so they are
 * accepted only as plain invocations of a known tool runner: no shell operators, no inline code or
 * preloads, nothing outside the workspace, no installs or download-and-run forms. The repository's
 * own scripts are still the repository's code; the check-control gate in policy.ts covers edits to
 * those.
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[|;&$`<>\\\n]/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] ?? "";
  if (!KNOWN_RUNNERS.test(first) || bashDenyReason(trimmed) !== null) return false;
  const runner = path.basename(first);
  const deny = RUNNER_DENY[runner];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!.replace(/^["']+|["']+$/g, "");
    if (hasPathOutsideWorkspace(token)) return false;
    if (deny?.test(token)) return false;
    if (/^python3?$/.test(runner) && token === "-m" && PYTHON_MODULE_DENY.test(tokens[i + 1] ?? "")) return false;
  }
  return true;
}

function realpathOfNearestExisting(absolute: string): string {
  let current = absolute;
  const missing: string[] = [];
  while (!existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}

/** True when `filePath` (resolved against `cwd`) lies inside `root`, following symlinks. */
export function isInside(filePath: string, cwd: string, root: string): boolean {
  const real = realpathOfNearestExisting(path.resolve(cwd, filePath));
  const rootReal = realpathOfNearestExisting(path.resolve(root));
  return real === rootReal || real.startsWith(rootReal + path.sep);
}

export function writeDenyReason(filePath: string, cwd: string, ctx: GuardContext): string | null {
  if (ctx.profile === "review") return "reviewers do not edit files";
  if (!isInside(filePath, cwd, ctx.workspace)) return `writes are limited to the workspace ${ctx.workspace}`;
  const rel = path.relative(ctx.workspace, path.resolve(cwd, filePath));
  if (rel.split(path.sep).includes(".git")) return "git internals are managed by the engine";
  if (isProtectedPath(rel, ctx.task)) return `protected path: ${rel}`;
  return null;
}

export function readDenyReason(filePath: string, cwd: string, ctx: GuardContext): string | null {
  const roots = [ctx.workspace, ...(ctx.readRoots ?? [])];
  if (roots.some((root) => isInside(filePath, cwd, root))) return null;
  return `reads are limited to the workspace ${ctx.workspace}`;
}

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Pure decision used by the PreToolUse hook. Returns a reason to deny, or null to allow. */
export function preToolDenyReason(toolName: string, toolInput: unknown, cwd: string, ctx: GuardContext): string | null {
  switch (toolName) {
    case "Bash": {
      const command = stringField(toolInput, "command") ?? "";
      return ctx.profile === "review" ? reviewerBashDenyReason(command) : bashDenyReason(command);
    }
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const file = stringField(toolInput, "file_path", "notebook_path");
      return file ? writeDenyReason(file, cwd, ctx) : "missing file path";
    }
    case "Read": {
      const file = stringField(toolInput, "file_path");
      return file ? readDenyReason(file, cwd, ctx) : "missing file path";
    }
    case "Glob":
    case "Grep": {
      const dir = stringField(toolInput, "path");
      return dir ? readDenyReason(dir, cwd, ctx) : null;
    }
    default:
      return null;
  }
}

export function buildHooks(ctx: GuardContext): NonNullable<Options["hooks"]> {
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const reason = preToolDenyReason(input.tool_name, input.tool_input, input.cwd, ctx);
    if (!reason) return {};
    ctx.onDeny?.(input.tool_name, reason);
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
  return { PreToolUse: [{ hooks: [preToolUse] }] };
}

export function toolsFor(profile: ToolProfile): { allowedTools: string[]; disallowedTools: string[] } {
  const readOnly = ["Read", "Glob", "Grep", "Bash"];
  const allowedTools = profile === "build" ? [...readOnly, "Edit", "Write"] : readOnly;
  return { allowedTools, disallowedTools: ["WebFetch", "WebSearch", "Agent", "NotebookEdit", "AskUserQuestion"] };
}

const ENV_PASS = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LANGUAGE|TZ|COLORTERM)$/,
  /^LC_/,
  /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/,
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^CLAUDE_CONFIG_DIR$/,
  /^(NVM_DIR|NVM_BIN|PYENV_ROOT|VOLTA_HOME|ASDF_DIR|GOPATH|GOROOT|CARGO_HOME|RUSTUP_HOME|JAVA_HOME)$/,
];
const CLOUD_PASS: [flag: string, pattern: RegExp][] = [
  ["CLAUDE_CODE_USE_BEDROCK", /^AWS_/],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", /^AWS_/],
  ["CLAUDE_CODE_USE_VERTEX", /^(GOOGLE_|CLOUD_ML_REGION|ANTHROPIC_VERTEX)/],
  ["CLAUDE_CODE_USE_FOUNDRY", /^(AZURE_|ANTHROPIC_FOUNDRY)/],
];

/** Environment for the agent subprocess: toolchain basics and model auth, no other credentials. */
export function scrubEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const cloud = CLOUD_PASS.filter(([flag]) => source[flag]).map(([, pattern]) => pattern);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_PASS.some((re) => re.test(key)) || cloud.some((re) => re.test(key))) out[key] = value;
  }
  out["CI"] = "1";
  out["GIT_TERMINAL_PROMPT"] = "0";
  out["NO_COLOR"] = "1";
  out["FORCE_COLOR"] = "0";
  return out;
}

/** Environment for repository commands the engine runs itself (install, tests): no model auth either. */
export function commandEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLOUD_ML_)/.test(key)));
}

const CREDENTIAL_PATHS = [
  ".ssh", ".aws", ".azure", ".gnupg", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".docker", ".kube", ".terraform.d",
  ".config/gh", ".config/gcloud", ".config/hub", ".cargo/credentials", ".cargo/credentials.toml", ".claude/.credentials.json",
];

function tempDirs(): string[] {
  return specFor(os.tmpdir(), false, { home: path.join(os.tmpdir(), "no-home") }).extraWrite.filter((dir) => !dir.includes("no-home"));
}

/**
 * Sandbox for the agent's shell: no network, writes only in the workspace (never `.git`) and the
 * temp dir, nothing at all for reviewers, and no credential files or model keys visible to commands.
 */
export function sandboxSettings(workspace: string, profile: ToolProfile, extraWrite: string[] = []): SandboxSettings {
  const home = os.homedir();
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], allowLocalBinding: true },
    filesystem: {
      // The same temp directories (per-user and the shared /tmp, as real paths) and tool caches the
      // repository's own commands get, so the agent can run the project's commands as documented.
      allowWrite: profile === "build" ? [...new Set([workspace, os.tmpdir(), ...specFor(workspace, false, { extraWrite }).extraWrite])] : [os.tmpdir(), ...tempDirs()],
      denyWrite: [path.join(workspace, ".git")],
      denyRead: CREDENTIAL_PATHS.map((p) => path.join(home, p)),
    },
    credentials: {
      envVars: [
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
      ],
    },
  };
}
