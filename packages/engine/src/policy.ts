import type { ChangePlan, DiffStats, Investigation, Review, Task, Verification } from "./types.ts";

/** Hard limits for one run. Every gate in the pipeline consults these. */
export interface Limits {
  maxCostUsd: number;
  maxWallClockMs: number;
  /** Implementation sessions in total, counting the first one and review-driven revisions. */
  maxImplementRounds: number;
  /** Review rounds that may send the change back for revision. */
  maxReviewRounds: number;
  maxFilesChanged: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxCostUsd: 10,
  maxWallClockMs: 45 * 60_000,
  maxImplementRounds: 4,
  maxReviewRounds: 2,
  maxFilesChanged: 20,
};

export type Decision =
  | { action: "continue" }
  | { action: "retry"; reason: string }
  | { action: "escalate"; reason: string; questions: string[] }
  | { action: "stop"; reason: string };

const CI_PATHS = [
  ".github/workflows/",
  ".github/actions/",
  ".circleci/",
  ".gitlab-ci.yml",
  ".travis.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
];
const SECRET_FILES = [/(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/, /(^|\/)\.(npmrc|pypirc|netrc)$/];

/** Paths a contribution should not touch unless the task is explicitly about them. */
export function isProtectedPath(filePath: string, task: Pick<Task, "kind">): boolean {
  const p = filePath.replace(/^\.\//, "");
  if (SECRET_FILES.some((re) => re.test(p))) return true;
  if (task.kind === "ci_rot") return false;
  return CI_PATHS.some((c) => (c.endsWith("/") ? p.startsWith(c) : p === c || p.endsWith("/" + c)));
}

/** Some opportunities are conversations with maintainers, not patches. The engine only prepares code changes. */
export function atIntake(task: Task): Decision {
  if (task.issue?.inFlight) return { action: "stop", reason: `issue #${task.issue.number} already has an assignee or an open pull request` };
  if (task.kind === "triage") return { action: "stop", reason: "this is a communication task (reply on the issue), not a code change" };
  if (task.kind === "stale_pr") {
    return {
      action: "escalate",
      reason: "reviving an abandoned pull request needs the original author's consent and co-authorship",
      questions: ["Has the original author been asked, and may their work be continued with co-authorship?"],
    };
  }
  if (task.kind === "hygiene" && task.files.length === 0) {
    return {
      action: "escalate",
      reason: "this hygiene item names no files; it may be a request to the maintainers rather than a change",
      questions: ["Is there a concrete file change here, or should a maintainer be asked instead?"],
    };
  }
  return { action: "continue" };
}

export function afterOrient(inv: Investigation): Decision {
  const reason = inv.reasons.join("; ") || inv.summary;
  if (inv.feasibility === "stop") return { action: "stop", reason };
  if (inv.feasibility === "needs_human") return { action: "escalate", reason, questions: inv.questions };
  return { action: "continue" };
}

export function afterPlan(plan: ChangePlan, task: Task, limits: Limits): Decision {
  if (plan.steps.length === 0) return { action: "stop", reason: "the plan has no steps" };
  const files = [...new Set([...plan.filesToModify, ...plan.filesToCreate])];
  if (files.length > limits.maxFilesChanged) {
    return {
      action: "escalate",
      reason: `plan touches ${files.length} files, limit is ${limits.maxFilesChanged}`,
      questions: ["Is a change of this size wanted, or should the scope be narrowed?"],
    };
  }
  const protectedFiles = files.filter((f) => isProtectedPath(f, task));
  if (protectedFiles.length > 0) {
    return {
      action: "escalate",
      reason: `plan touches protected paths: ${protectedFiles.join(", ")}`,
      questions: [`May the change edit ${protectedFiles.join(", ")}?`],
    };
  }
  if (plan.needsNewDependency) {
    return {
      action: "escalate",
      reason: "plan adds a dependency",
      questions: ["Adding a dependency is a maintainer decision. Is it acceptable here, or is there a dependency-free approach?"],
    };
  }
  return { action: "continue" };
}

/** The plan is a promise; the diff is what happened. The same limits apply to both. */
export function afterDiff(diff: DiffStats, task: Task, limits: Limits): Decision {
  if (diff.files > limits.maxFilesChanged) {
    return {
      action: "escalate",
      reason: `the change touches ${diff.files} files, limit is ${limits.maxFilesChanged}`,
      questions: ["Is a change of this size wanted, or did the agent run a formatter or generator over the tree?"],
    };
  }
  const protectedFiles = diff.changedFiles.filter((f) => isProtectedPath(f, task));
  if (protectedFiles.length > 0) {
    return {
      action: "escalate",
      reason: `the change touches protected paths: ${protectedFiles.join(", ")}`,
      questions: [`May the change edit ${protectedFiles.join(", ")}?`],
    };
  }
  return { action: "continue" };
}

const SECRET_PATTERNS: [name: string, pattern: RegExp][] = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["OpenAI key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
];

/** Names of secret-looking strings in the added lines of a patch. */
export function findSecrets(patch: string): string[] {
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  return SECRET_PATTERNS.filter(([, re]) => re.test(added)).map(([name]) => name);
}

/** Stable fingerprint of a failed verification, used to detect the same failure twice in a row. */
export function failureSignature(v: Verification): string {
  return v.checks
    .filter((c) => c.status === "fail" || c.status === "timeout")
    .map((c) => `${c.name}:${c.outputTail.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ")}`)
    .join("\n");
}

export function afterVerify(
  v: Verification,
  attempt: number,
  previousSignature: string | undefined,
  limits: Limits,
): Decision {
  if (v.ok) return { action: "continue" };
  const failed = v.checks.filter((c) => c.status === "fail" || c.status === "timeout").map((c) => c.name);
  const signature = failureSignature(v);
  if (previousSignature !== undefined && signature === previousSignature) {
    return {
      action: "escalate",
      reason: `the same verification failure repeated (${failed.join(", ")})`,
      questions: ["The agent could not get past this failure. Is the task well-specified, or is the environment missing something?"],
    };
  }
  if (attempt >= limits.maxImplementRounds) {
    return {
      action: "escalate",
      reason: `verification still failing after ${attempt} attempts (${failed.join(", ")})`,
      questions: ["Should a human finish this, or should the scope change?"],
    };
  }
  return { action: "retry", reason: `verification failed: ${failed.join(", ")}` };
}

/** Normalised keys for findings serious enough to block a merge. */
export function blockerKeys(review: Review): string[] {
  return review.findings
    .filter((f) => f.severity === "blocker" || f.severity === "major")
    .map((f) => `${f.file}:${f.summary}`.toLowerCase().replace(/\s+/g, " ").trim());
}

export function afterReview(review: Review, round: number, attempt: number, previousBlockers: string[], limits: Limits): Decision {
  if (review.verdict === "approve") return { action: "continue" };
  const blockers = blockerKeys(review);
  if (review.verdict === "reject") {
    return {
      action: "escalate",
      reason: `reviewer rejected the change: ${review.prNotes || blockers.join("; ") || "no reason given"}`,
      questions: ["Should the approach change, or should this task be dropped?"],
    };
  }
  // "revise" with nothing serious is not worth another model round; minor notes go into the PR.
  if (blockers.length === 0) return { action: "continue" };
  const survived = blockers.filter((b) => previousBlockers.includes(b));
  if (survived.length > 0) {
    return {
      action: "escalate",
      reason: `a review finding survived a revision: ${survived[0]}`,
      questions: ["The implementer and reviewer disagree. Which side is right?"],
    };
  }
  if (round >= limits.maxReviewRounds || attempt >= limits.maxImplementRounds) {
    return {
      action: "escalate",
      reason: `review still requests changes after ${round} review rounds and ${attempt} implementation attempts`,
      questions: ["Should a human take over the remaining findings?"],
    };
  }
  return { action: "retry", reason: `review requested changes: ${blockers.join("; ")}` };
}

export function checkBudget(costUsd: number, elapsedMs: number, limits: Limits): Decision {
  if (costUsd > limits.maxCostUsd) {
    return { action: "stop", reason: `cost ${costUsd.toFixed(2)} USD exceeded the limit of ${limits.maxCostUsd} USD` };
  }
  if (elapsedMs > limits.maxWallClockMs) {
    return { action: "stop", reason: `run exceeded the time limit of ${Math.round(limits.maxWallClockMs / 60_000)} minutes` };
  }
  return { action: "continue" };
}
