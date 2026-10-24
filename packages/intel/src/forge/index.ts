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
  /** Budget for the whole forge phase; defaults to three minutes. */
  deadline?: AbortSignal | undefined;
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
  const failures: string[] = [];
  const fetchOptions: ForgeFetchOptions = { ...options, counter, failures, deadline: options.deadline ?? AbortSignal.timeout(180_000) };
  const result = kind === "gitlab" ? await fetchGitLab(host, owner, name, fetchOptions) : await fetchGitea(host, owner, name, fetchOptions);
  const notes = [...(result.notes ?? [])];
  if (failures.length) notes.push(`${host}: ${failures.length} API request${failures.length === 1 ? "" : "s"} failed (${[...new Set(failures)].slice(0, 6).join(", ")}); comments, maintainers or linked merge requests may be incomplete`);
  return { ...result, notes, requests: counter.requests };
}
