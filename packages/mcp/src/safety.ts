/*
 * The repository an MCP tool analyzes is usually chosen by a model, and a model can be steered by
 * text planted in a README, an issue or an earlier tool result. These defences assume the
 * repository, and the choice of repository, are hostile.
 */

/**
 * Hosts the tools read. Two reasons it is GitHub alone: intel clones `https://<host>/<owner>/<name>.git`
 * as given, so an open list would let a model point the server at the person's own network; and
 * discovery and intel read metadata from GitHub's API by owner and name, so any other forge would be
 * answered with whatever GitHub repository shares the name. Other forges return when both read them.
 */
export const DEFAULT_HOSTS = ["github.com"] as const;

export function allowedHosts(): Set<string> {
  return new Set<string>(DEFAULT_HOSTS);
}

/** Git settings applied to every git command the server runs. */
export const GIT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  // A committed symlink (README.md -> ~/.ssh/id_ed25519, or -> /dev/zero) is checked out as a small
  // text file holding the link target, so reading it can never reach outside the clone.
  ["core.symlinks", "false"],
  // Clones only ever need HTTPS; refuse file://, ssh, git:// and ext:: even if a URL slips through.
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
];

/**
 * Applies GIT_SETTINGS through git's environment configuration (GIT_CONFIG_COUNT, git 2.31 and
 * later), after any entries the person already set. It must run before any module that copies
 * process.env for its git calls, which is why main.ts imports ./env.ts first.
 */
export function hardenGitEnvironment(env: NodeJS.ProcessEnv): void {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  for (const [key, value] of GIT_SETTINGS) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    index++;
  }
  env.GIT_CONFIG_COUNT = String(index);
}

// C0 controls other than tab and newline, DEL, C1 controls, and bidirectional overrides. Repository
// text containing them could rewrite a terminal or disguise what a line says.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}

/** stripControl applied to every string inside a JSON-like value. */
export function stripControlDeep<T>(value: T): T {
  if (typeof value === "string") return stripControl(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripControlDeep(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripControlDeep(item)])) as T;
  }
  return value;
}
