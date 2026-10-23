import type { Task } from "./types.ts";

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  // Cut at a word boundary so the slug never ends in a fragment.
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, maxLength)).replace(/-+$/g, "");
}

const KIND_TYPE: Record<string, string> = {
  issue: "fix",
  triage: "fix",
  stale_pr: "fix",
  feature_request: "feat",
  docs_drift: "docs",
  broken_link: "docs",
  test_gap: "test",
  tech_debt: "refactor",
  hygiene: "chore",
  dependency: "chore",
  deprecation: "chore",
  ci_rot: "ci",
};

/** Conventional-commit type that best matches an opportunity kind. */
export function typeForKind(kind: string): string {
  return KIND_TYPE[kind] ?? "fix";
}

export function branchNameFor(task: Task): string {
  const topic = task.issue ? `${task.issue.number}-${slugify(task.title, 30)}` : slugify(task.title);
  return `gitgoblin/${typeForKind(task.kind)}-${topic}`.replace(/-+$/g, "");
}

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?:\s/;

/** True when the repository writes conventional commits, judged from intel's hint or recent subjects. */
export function usesConventionalCommits(task: Task): boolean {
  const style = task.conventions.commitStyle;
  if (style === "conventional") return true;
  if (style === "freeform" || style === "plain") return false;
  const subjects = task.conventions.recentCommitSubjects;
  if (subjects.length === 0) return false;
  return subjects.filter((s) => CONVENTIONAL.test(s)).length * 2 >= subjects.length;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[\s,;:.-]+$/, "") + "…";
}

/** One-line description of the change, from the plan goal when it is short, else the task title. */
export function changeSummary(task: Task, goal: string | undefined): string {
  const candidate = goal && goal.length <= 60 ? goal : task.title;
  return candidate.replace(/\.$/, "").trim();
}

/** Commit subject and PR title, in the repository's style, at most 72 characters. */
export function subjectFor(task: Task, goal: string | undefined): string {
  const summary = changeSummary(task, goal);
  if (usesConventionalCommits(task)) {
    const description = summary.replace(/^[a-z]+(\([^)]+\))?!?:\s*/i, "");
    const body = description.charAt(0).toLowerCase() + description.slice(1);
    return clip(`${typeForKind(task.kind)}: ${body}`, 72);
  }
  return clip(summary.charAt(0).toUpperCase() + summary.slice(1), 72);
}
