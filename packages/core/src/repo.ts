/**
 * Repository identity shared by every gitgoblin component.
 *
 * `host` is a hostname ("github.com", "gitlab.com", "codeberg.org"), never an
 * enum, so self-hosted forges work without code changes.
 */
export interface RepoRef {
  host: string;
  owner: string;
  name: string;
}

/** Facts about a repository as reported by its host. Optional fields are unknown, not absent. */
export interface RepoFacts extends RepoRef {
  url: string;
  description?: string | undefined;
  homepage?: string | undefined;
  topics: string[];
  language?: string | undefined;
  /** SPDX identifier when known ("MIT", "Apache-2.0"), "NOASSERTION" for custom licenses. */
  license?: string | undefined;
  stars: number;
  forks: number;
  openIssues: number;
  /** ISO 8601 timestamps. */
  createdAt?: string | undefined;
  pushedAt?: string | undefined;
  archived: boolean;
  fork: boolean;
  defaultBranch?: string | undefined;
  /** Size in kilobytes, when the host reports it. */
  sizeKb?: number | undefined;
}

const HOST_ALIASES: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  codeberg: "codeberg.org",
  bitbucket: "bitbucket.org",
};

/** Lowercases a host and expands shorthand like "github" to "github.com". */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/^www\./, "");
  return HOST_ALIASES[lower] ?? lower;
}

/** Stable, lowercase identifier: "github.com/owner/name". Use it as a map key. */
export function repoId(ref: RepoRef): string {
  return `${normalizeHost(ref.host)}/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
}

/** Browser URL for the repository. */
export function repoUrl(ref: RepoRef): string {
  return `https://${normalizeHost(ref.host)}/${ref.owner}/${ref.name}`;
}

/** True when two refs point at the same repository, ignoring case. */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return repoId(a) === repoId(b);
}

/** Returns only the identity fields of any object that carries a RepoRef. */
export function toRepoRef(ref: RepoRef): RepoRef {
  return { host: normalizeHost(ref.host), owner: ref.owner, name: ref.name };
}

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$|^[A-Za-z0-9]$/;
// Repository names may also start with "." or "_" (".github", "_site") and end with "_"; never "-"
// first (git and ssh would read an option), and the last character rules out "." and "..".
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*[A-Za-z0-9_]$|^[A-Za-z0-9_]$/;

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

/**
 * A forge is reached by a DNS name with at least one dot: never an IP address, a path, a name that
 * starts with "-" (it would read as an option to git or ssh), or a bare name such as localhost.
 */
const LABEL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
// URLs and the system resolver read a host whose last label is a number as an IPv4 address, in hex
// and octal too: "0x7f.1" and "017.0.0.1" are 127.0.0.1, "example.123" is no name at all.
const NUMERIC_LAST_LABEL = /(?:^|\.)(?:\d+|0x[\da-f]*)$/i;

export function isForgeHost(host: string): boolean {
  return HOSTNAME.test(host) && !NUMERIC_LAST_LABEL.test(host);
}

/** gitlab.com and self-hosted instances named like gitlab.gnome.org. */
function isGitLab(host: string): boolean {
  const clean = normalizeHost(host);
  return clean === "gitlab.com" || clean.startsWith("gitlab.");
}

function fromSegments(host: string, owner: string, name: string): RepoRef | undefined {
  const cleanName = stripGitSuffix(name);
  const cleanHost = normalizeHost(host);
  if (!isForgeHost(cleanHost) || !SEGMENT.test(owner) || !NAME.test(cleanName)) return undefined;
  return { host: cleanHost, owner, name: cleanName };
}

/**
 * Parses the ways people write repositories:
 * "owner/name", "host/owner/name", "https://host/owner/name[.git][/...]",
 * "git@host:owner/name.git". Returns undefined when the input is not a repository.
 */
export function parseRepoRef(input: string, defaultHost = "github.com"): RepoRef | undefined {
  const text = input.trim();
  if (text === "") return undefined;

  const ssh = /^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (ssh && !text.includes("://")) {
    const [, host, owner, name] = ssh;
    return fromSegments(host ?? "", owner ?? "", name ?? "");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    // Repositories are reached over the web or ssh; a port or embedded credentials would be dropped
    // silently from a RepoRef, so such URLs are refused instead of half-understood.
    if (!["http:", "https:", "ssh:", "git:", "git+ssh:"].includes(url.protocol)) return undefined;
    if (url.port || url.password || (url.username && url.protocol !== "ssh:" && url.protocol !== "git+ssh:")) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    // GitLab nests projects in subgroups ("group/sub/project") and puts project pages after "/-/". A
    // RepoRef has one owner, so a deeper project is refused instead of cut down to its group.
    // shortcut: only hosts named gitlab.* are known to be GitLab; support subgroups if callers need them.
    if (isGitLab(url.hostname)) {
      const dash = segments.indexOf("-");
      if ((dash === -1 ? segments.length : dash) > 2) return undefined;
    }
    const [owner, name] = segments;
    if (!owner || !name) return undefined;
    return fromSegments(url.hostname, owner, name);
  }

  const parts = text.split("/").filter(Boolean);
  if (parts.length === 2) return fromSegments(defaultHost, parts[0] ?? "", parts[1] ?? "");
  if (parts.length === 3 && (parts[0] ?? "").includes(".")) {
    return fromSegments(parts[0] ?? "", parts[1] ?? "", parts[2] ?? "");
  }
  return undefined;
}
