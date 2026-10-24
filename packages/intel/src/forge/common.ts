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
  /** List endpoints that failed, so the report can say which fields may be incomplete. */
  failures?: string[] | undefined;
  /** One budget for the whole forge phase, on top of each request's own timeout. */
  deadline?: AbortSignal | undefined;
}

/** A forge answer larger than this is refused: list endpoints return kilobytes, not hundreds of megabytes. */
export const MAX_FORGE_BODY = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * GET JSON from a forge API, cached on disk; throws on non-2xx. Redirects are followed by hand and only to https on
 * the same host (a self-hosted forge must not be able to point requests at the operator's network), and the body is
 * read with a size cap before parsing.
 */
export async function forgeJson<T>(url: string, options: ForgeFetchOptions): Promise<T> {
  const key = `forge:${url}`;
  const cached = await options.cache?.get<T>(key, options.cacheTtlMs ?? 3_600_000);
  if (cached !== undefined) return cached;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const response = await options.fetchImpl(current.toString(), {
      headers: { accept: "application/json", "user-agent": "gitgoblin-intel" },
      redirect: "manual",
      signal: options.deadline ? AbortSignal.any([timeout, options.deadline]) : timeout,
    });
    options.counter.requests++;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? new URL(location, current) : undefined;
      if (!next || hop >= MAX_REDIRECTS || next.protocol !== "https:" || next.host !== current.host) {
        await response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error(`redirect for ${url} refused (to ${next ? next.host : "nowhere"})`), { status: response.status });
      }
      await response.body?.cancel().catch(() => undefined);
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`${response.status} for ${url}`), { status: response.status });
    }
    const value = JSON.parse(await readCapped(response, MAX_FORGE_BODY)) as T;
    await options.cache?.set(key, value);
    return value;
  }
}

/** The response text, refusing anything over `max` bytes, early when the server declares its length. */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`response of ${declared} bytes is over the ${max}-byte limit`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response over the ${max}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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

/**
 * A forge list endpoint's answer as an array. A failure (an error status, a timeout, an error object or HTML where
 * a list belongs) is no items, and is recorded so the report can say which fields may be incomplete.
 */
export async function forgeList<T>(url: string, options: ForgeFetchOptions): Promise<T[]> {
  const endpoint = new URL(url).pathname.replace(/^\/api\/v\d\/(projects|repos)\/[^/]+(\/[^/]+)?/, "") || "/";
  try {
    const value = await forgeJson<unknown>(url, options);
    if (Array.isArray(value)) return value as T[];
    options.failures?.push(`${endpoint} (unexpected response)`);
  } catch (error) {
    options.failures?.push(`${endpoint} (${statusOf(error) ?? (error as Error).name})`);
  }
  return [];
}

/** HTTP status of a failed forge request, when there was a response. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function commentOf(login: string | undefined, createdAt: string, body: string | undefined, maintainers: Set<string>): CommentSample {
  return { createdAt, author: actorOf(login), association: associationOf(login, maintainers), body };
}
