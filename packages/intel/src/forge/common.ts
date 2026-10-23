import type { DiskCache } from "../util/cache.ts";
import type { Actor, AuthorAssociation, CommentSample } from "../github/types.ts";
import { isBotLogin } from "../github/types.ts";

export type ForgeKind = "gitlab" | "gitea";

/** Hosts whose API family we know; anything else is probed at run time. */
export function knownForge(host: string): ForgeKind | undefined {
  if (/(^|\.)gitlab\.(com|org|io)$|gitlab\./i.test(host)) return "gitlab";
  if (/^(codeberg\.org|gitea\.com|try\.gitea\.io|next\.forgejo\.org|code\.forgejo\.org)$/i.test(host)) return "gitea";
  return undefined;
}

export interface ForgeFetchOptions {
  fetchImpl: typeof fetch;
  cache?: DiskCache | undefined;
  cacheTtlMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** Incremented per network request so the budget can report it. */
  counter: { requests: number };
}

/** GET JSON from a forge API, cached on disk; throws on non-2xx. */
export async function forgeJson<T>(url: string, options: ForgeFetchOptions): Promise<T> {
  const key = `forge:${url}`;
  const cached = await options.cache?.get<T>(key, options.cacheTtlMs ?? 3_600_000);
  if (cached !== undefined) return cached;
  const response = await options.fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "gitgoblin-intel" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  options.counter.requests++;
  if (!response.ok) throw Object.assign(new Error(`${response.status} for ${url}`), { status: response.status });
  const value = (await response.json()) as T;
  await options.cache?.set(key, value);
  return value;
}

export function actorOf(login: string | undefined): Actor | undefined {
  return login ? { login, isBot: isBotLogin(login) } : undefined;
}

/** Maintainer status inferred from who merges and closes: the forge APIs expose no author association without a token. */
export function associationOf(login: string | undefined, maintainers: Set<string>): AuthorAssociation {
  return login && maintainers.has(login) ? "MEMBER" : "NONE";
}

/**
 * Issue numbers a pull request says it closes, from its description: the closing keywords GitHub,
 * GitLab and Gitea honour. "See #45" or "related to #45" is a mention, not a fix.
 */
export function referencedIssues(body: string | null | undefined): number[] {
  const out = new Set<number>();
  for (const m of (body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]{0,3}:?[ \t]{0,3}#(\d{1,6})\b/gi)) out.add(Number(m[1]));
  return [...out];
}

/** A forge list endpoint's answer as an array; anything else (an error object, HTML parsed as JSON) is no items. */
export async function forgeList<T>(url: string, options: ForgeFetchOptions): Promise<T[]> {
  try {
    const value = await forgeJson<unknown>(url, options);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

/** HTTP status of a failed forge request, when there was a response. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function commentOf(login: string | undefined, createdAt: string, body: string | undefined, maintainers: Set<string>): CommentSample {
  return { createdAt, author: actorOf(login), association: associationOf(login, maintainers), body };
}
