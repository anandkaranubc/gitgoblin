/*
 * The repository an MCP tool analyzes is usually chosen by a model, and a model can be steered by
 * text planted in a README, an issue or an earlier tool result. These defences assume the
 * repository, and the choice of repository, are hostile.
 */

/**
 * Hosts the discovery tools read. Discovery and explain look repositories up through GitHub's API by
 * owner and name, so any other host would be answered about whatever GitHub repository shares the name.
 */
export const DISCOVERY_HOSTS = ["github.com"] as const;

/**
 * Hosts the analysis tools read. Intel reads GitLab and Gitea/Forgejo through their public APIs, but it
 * also clones `https://<host>/<owner>/<name>.git` as given, so the list stays a fixed set of public
 * forges: an open list would let a model point the server at the person's own network.
 */
export const ANALYSIS_HOSTS = ["github.com", "gitlab.com", "codeberg.org"] as const;

// Control and format characters (Unicode Cc and Cf) other than tab and newline, plus line and paragraph
// separators: terminal escapes, bidirectional overrides, zero-width characters, the invisible tag
// characters U+E0000 to U+E007F. Repository text containing them could rewrite a terminal, disguise
// what a line says, or carry instructions a person cannot see.
const CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}\u2028\u2029]/gu;

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

/** Longest text a single result may carry. Larger answers are cut, with a note saying so. */
export const MAX_RESULT_CHARS = 20_000;
const MAX_STRUCTURED_STRING = 2_000;
const MAX_STRUCTURED_ITEMS = 50;

/** Caps every string and list inside a JSON-like value, so one hostile repository cannot flood the agent's context. */
export function capDeep<T>(value: T): T {
  if (typeof value === "string") return (value.length > MAX_STRUCTURED_STRING ? `${value.slice(0, MAX_STRUCTURED_STRING - 1)}…` : value) as T;
  if (Array.isArray(value)) return value.slice(0, MAX_STRUCTURED_ITEMS).map((item) => capDeep(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capDeep(item)])) as T;
  return value;
}

/** Cuts text to MAX_RESULT_CHARS at a line boundary and says how much was left out. */
export function capText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const cut = text.lastIndexOf("\n", MAX_RESULT_CHARS);
  const kept = text.slice(0, cut > MAX_RESULT_CHARS / 2 ? cut : MAX_RESULT_CHARS);
  return `${kept}\n[result cut: ${text.length - kept.length} more characters left out]`;
}
