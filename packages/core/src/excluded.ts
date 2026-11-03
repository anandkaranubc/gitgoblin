import { type RepoRef, repoId } from "./repo.ts";

/**
 * Projects whose maintainers asked gitgoblin to leave them alone. docs/excluded-projects.md is the
 * source of truth: one entry per line under its "## List" heading, "host/owner/name" for a
 * repository or "host/owner" for everything an owner has.
 */

/** The current list, so a new opt-out applies without waiting for a release. */
export const EXCLUDED_PROJECTS_URL = "https://raw.githubusercontent.com/anandkaranubc/gitgoblin/main/docs/excluded-projects.md";

/** The list as this release shipped it. A test keeps it equal to docs/excluded-projects.md. */
export const EXCLUDED_PROJECTS: readonly string[] = [];

const ENTRY = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/;
// Entries are short; a longer line is prose, and the cap keeps matching cheap on any input.
const MAX_ENTRY = 256;

/** The entries in the file, lowercased. Lines that are not an entry, such as the "no projects yet" sentence, are skipped. */
export function parseExcludedProjects(markdown: string): string[] {
  const entries: string[] = [];
  let inList = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      inList = /^##\s+List$/i.test(line);
      continue;
    }
    if (!inList || line.length > MAX_ENTRY) continue;
    const entry = line.replace(/^[-*]\s+/, "").replace(/^`([^`]*)`$/, "$1").toLowerCase();
    if (ENTRY.test(entry)) entries.push(entry);
  }
  return entries;
}

/** The entry that covers `ref`, or undefined when its maintainers have not opted out. */
export function excludedEntry(ref: RepoRef, entries: readonly string[] = EXCLUDED_PROJECTS): string | undefined {
  const id = repoId(ref);
  const owner = id.slice(0, id.lastIndexOf("/"));
  return entries.find((entry) => {
    const clean = entry.toLowerCase();
    return clean === id || clean === owner;
  });
}
