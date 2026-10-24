import type { RepoRef } from "@gitgoblin/core";

/*
 * The server reads public repositories only. A token (GITHUB_TOKEN, or the GitHub CLI's login) and a
 * git credential helper can both reach private ones, and the repository is chosen by a model that
 * can be steered, so visibility is confirmed with an anonymous request to the forge before any work.
 */

export type Visibility = { public: true } | { public: false; reason: string };

const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 10_000;

async function anonymousJson(url: string, fetchImpl: typeof fetch): Promise<{ status: number; body?: Record<string, unknown> | undefined }> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "gitgoblin-mcp" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return { status: response.status };
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function verdict(status: number, isPublic: boolean | undefined): Visibility {
  if (status === 404) return { public: false, reason: "no public repository by that name" };
  if (isPublic === true) return { public: true };
  if (isPublic === false) return { public: false, reason: "the repository is not public" };
  return { public: false, reason: `its forge answered HTTP ${status}` };
}

/** Asks the forge, without credentials, whether the repository is public. */
export async function checkPublic(ref: RepoRef, fetchImpl: typeof fetch = fetch): Promise<Visibility> {
  const owner = encodeURIComponent(ref.owner);
  const name = encodeURIComponent(ref.name);
  try {
    if (ref.host === "github.com") {
      const api = await anonymousJson(`https://api.github.com/repos/${owner}/${name}`, fetchImpl);
      if (api.status === 200) return verdict(200, api.body?.private === false && (api.body?.visibility ?? "public") === "public");
      if (api.status !== 403 && api.status !== 429) return verdict(api.status, undefined);
      // Anonymous API calls are limited to 60 an hour; the repository page answers 404 to anonymous visitors when it is private.
      const page = await fetchImpl(`https://github.com/${owner}/${name}`, { method: "HEAD", headers: { "User-Agent": "gitgoblin-mcp" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const landed = new URL(page.url || `https://github.com/${owner}/${name}`);
      return verdict(page.status, page.ok ? landed.hostname === "github.com" && !landed.pathname.startsWith("/login") : undefined);
    }
    if (ref.host === "gitlab.com") {
      const api = await anonymousJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${ref.owner}/${ref.name}`)}`, fetchImpl);
      return verdict(api.status, api.status === 200 ? api.body?.visibility === "public" : undefined);
    }
    if (ref.host === "codeberg.org") {
      const api = await anonymousJson(`https://codeberg.org/api/v1/repos/${owner}/${name}`, fetchImpl);
      return verdict(api.status, api.status === 200 ? api.body?.private === false && api.body?.internal !== true : undefined);
    }
    return { public: false, reason: `gitgoblin cannot confirm visibility on ${ref.host}` };
  } catch (error) {
    return { public: false, reason: `its forge could not be reached (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** checkPublic with a short memory, so a discovery list or a briefing after an analysis costs nothing extra. */
export function createPublicChecker(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): (ref: RepoRef) => Promise<Visibility> {
  const cache = new Map<string, { at: number; visibility: Visibility }>();
  return async (ref) => {
    const key = `${ref.host}/${ref.owner}/${ref.name}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.visibility;
    const visibility = await checkPublic(ref, fetchImpl);
    // Only confirmed answers are remembered; a network error is asked again next time.
    if (visibility.public || /not public|no public repository/.test(visibility.reason)) cache.set(key, { at: now(), visibility });
    return visibility;
  };
}
