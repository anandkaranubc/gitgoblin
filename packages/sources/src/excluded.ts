import { EXCLUDED_PROJECTS, EXCLUDED_PROJECTS_URL, parseExcludedProjects } from "@gitgoblin/core";
import type { HttpClient } from "./http/client.ts";

/** How long a fetched list is reused, and so how long a new opt-out takes to reach every install. */
export const EXCLUDED_PROJECTS_TTL_MS = 6 * 60 * 60 * 1000;

/** The shipped list plus the current one; see loadExcludedProjects. */
export async function fetchExcludedProjects(http: HttpClient): Promise<string[]> {
  try {
    const current = parseExcludedProjects(await http.text(EXCLUDED_PROJECTS_URL, { ttlMs: EXCLUDED_PROJECTS_TTL_MS, retries: 0 }));
    return [...new Set([...EXCLUDED_PROJECTS, ...current])];
  } catch {
    return [...EXCLUDED_PROJECTS];
  }
}
