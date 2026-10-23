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

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

function fromSegments(host: string, owner: string, name: string): RepoRef | undefined {
  const cleanName = stripGitSuffix(name);
  if (!SEGMENT.test(owner) || !SEGMENT.test(cleanName)) return undefined;
  return { host: normalizeHost(host), owner, name: cleanName };
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

  if (/^[a-z]+:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    const [owner, name] = url.pathname.split("/").filter(Boolean);
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
