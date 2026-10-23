import type { DiskCache } from "../util/cache.ts";
import { type ForgeFetchOptions, type ForgeKind, forgeJson, knownForge, statusOf } from "./common.ts";
import { fetchGitea } from "./gitea.ts";
import { type ForgeResult, fetchGitLab } from "./gitlab.ts";

export type { ForgeKind } from "./common.ts";
export type { ForgeResult } from "./gitlab.ts";

export interface ForgeOptions {
  fetchImpl: typeof fetch;
  cache?: DiskCache | undefined;
  cacheTtlMs?: number | undefined;
}

/** Which API a host speaks: known hosts by name, others by probing the Gitea then GitLab version endpoints. */
export async function detectForge(host: string, options: ForgeOptions): Promise<ForgeKind | undefined> {
  const known = knownForge(host);
  if (known) return known;
  const probe: ForgeFetchOptions = { ...options, counter: { requests: 0 }, timeoutMs: 6000 };
  try {
    await forgeJson(`https://${host}/api/v1/version`, probe);
    return "gitea";
  } catch {
    // not Gitea
  }
  try {
    await forgeJson(`https://${host}/api/v4/version`, probe);
    return "gitlab";
  } catch (error) {
    // Self-hosted GitLab (salsa.debian.org, invent.kde.org) requires a token for /version but still answers it.
    return statusOf(error) === 401 ? "gitlab" : undefined;
  }
}

/** Metadata plus issue and PR samples from a non-GitHub forge, or undefined when its API is not reachable. */
export async function fetchForge(kind: ForgeKind, host: string, owner: string, name: string, options: ForgeOptions): Promise<ForgeResult & { requests: number }> {
  const counter = { requests: 0 };
  const fetchOptions: ForgeFetchOptions = { ...options, counter };
  const result = kind === "gitlab" ? await fetchGitLab(host, owner, name, fetchOptions) : await fetchGitea(host, owner, name, fetchOptions);
  return { ...result, requests: counter.requests };
}
