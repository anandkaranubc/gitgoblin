import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { fetchFailedJobs } from "../github/fetch.ts";
import type { WorkflowRun } from "../github/types.ts";
import { daysAgo } from "../util/time.ts";
import { type Analyzer, type Finding, evidence } from "./types.ts";

export interface WorkflowHealth {
  path: string;
  name: string;
  /** Newest first. */
  runs: WorkflowRun[];
  /** Consecutive failures at the head of the history. */
  redStreak: number;
  /** Runs that needed a re-run to reach success. */
  rerunsToGreen: number;
}

/** Group runs by workflow and summarise each one's recent health. */
export function workflowHealth(runs: WorkflowRun[]): WorkflowHealth[] {
  const byWorkflow = new Map<number, WorkflowRun[]>();
  for (const run of runs) byWorkflow.set(run.workflowId, [...(byWorkflow.get(run.workflowId) ?? []), run]);
  const out: WorkflowHealth[] = [];
  for (const group of byWorkflow.values()) {
    const sorted = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let redStreak = 0;
    for (const run of sorted) {
      if (run.conclusion === "failure" || run.conclusion === "timed_out") redStreak++;
      else break;
    }
    out.push({
      path: sorted[0]!.path,
      name: sorted[0]!.name,
      runs: sorted,
      redStreak,
      rerunsToGreen: sorted.filter((r) => r.conclusion === "success" && r.attempt > 1).length,
    });
  }
  return out;
}

/** Repository secrets a workflow reads, other than the token every run gets; "inherited" when it passes all of them on. */
export function workflowSecrets(yaml: string): string[] {
  const code = yaml.replace(/(^|\s)#.*$/gm, "$1");
  const names = [...code.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!).filter((n) => n !== "GITHUB_TOKEN");
  if (/\bsecrets:\s*inherit\b/.test(code)) names.push("inherited");
  return [...new Set(names)];
}

/** Whether pull requests trigger the workflow at all. */
export function runsOnPullRequests(yaml: string): boolean {
  return /\bpull_request(_target)?\b/.test(yaml.replace(/(^|\s)#.*$/gm, "$1"));
}

export const ciHealthAnalyzer: Analyzer = {
  name: "ci-health",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (ctx.runs.length === 0 || (!ctx.github && !ctx.failedJobs)) return [];
    const findings: Finding[] = [];
    const fixInFlight = (ctx.samples?.openPrs ?? []).find((p) => /\b(ci|workflow|build|tests?)\b/i.test(p.title) && /\b(fix|repair|unbreak|green)\b/i.test(p.title) && daysAgo(p.updatedAt, ctx.now) < 30);

    for (const wf of workflowHealth(ctx.runs)) {
      if (wf.redStreak >= 1 && wf.runs.length >= 1) {
        const latest = wf.runs[0]!;
        // One failed run is not a pattern, even when it is the only run on record.
        const stable = wf.redStreak >= 3 || (wf.redStreak >= 2 && wf.redStreak === wf.runs.length);
        const firstRed = wf.runs[wf.redStreak - 1]!;
        const jobs = await (ctx.failedJobs ? ctx.failedJobs(latest.id) : ctx.github ? fetchFailedJobs(ctx.github, ctx.ref.owner, ctx.ref.name, latest.id) : Promise.resolve([])).catch(() => []);
        const peripheral = jobs.length > 0 && jobs.every((j) => /bench|nightly|canary|experimental|optional|allow.?fail|coverage|docs?\b|lint|publish|release|deploy/i.test(j.name));
        // A job that needs the repository's secrets cannot run in a fork; one that never runs on pull requests cannot
        // even be checked by the contributor's own PR. Only a maintainer can verify such a fix (often a token rotation).
        const yaml = (await ctx.read(wf.path).catch(() => undefined)) ?? "";
        const secrets = workflowSecrets(yaml);
        const onPrs = runsOnPullRequests(yaml);
        const secretBound = secrets.length > 0 && (!onPrs || peripheral);
        const secretNote = `${onPrs ? "" : "runs only after merge and "}needs repository secrets (${secrets.slice(0, 3).join(", ")}) that forks do not get`;
        const ev = [evidence(ctx, "workflow_run", latest.url, { note: `${wf.name} (${wf.path}) ${latest.conclusion} on ${latest.event} to ${profile.defaultBranch}, ${latest.updatedAt.slice(0, 10)}; ${wf.redStreak} of the last ${wf.runs.length} runs failed` })];
        for (const job of jobs.slice(0, 4)) ev.push(evidence(ctx, "workflow_run", job.url, { excerpt: job.failedSteps.join(" / ") || undefined, note: `job "${job.name}" failed${job.failedSteps.length ? " at step" : ""}` }));
        findings.push({
          kind: "ci_rot",
          clusterKey: `ci-red:${wf.path}`,
          title: stable ? `CI workflow "${wf.name}" has been failing on ${profile.defaultBranch} since ${firstRed.updatedAt.slice(0, 10)}` : `Latest "${wf.name}" run on ${profile.defaultBranch} failed`,
          summary: stable
            ? `The ${wf.name} workflow fails on every recent run of the default branch${jobs[0] ? `, most recently in job "${jobs[0].name}"${jobs[0].failedSteps[0] ? ` at step "${jobs[0].failedSteps[0]}"` : ""}` : ""}. A red default branch hides new regressions and discourages contributors.`
            : `The newest run of ${wf.name} on the default branch failed after earlier successes${jobs[0] ? ` (job "${jobs[0].name}"${jobs[0].failedSteps[0] ? `, step "${jobs[0].failedSteps[0]}"` : ""})` : ""}; it may be a fresh breakage or a flaky job.`,
          evidence: ev,
          files: [wf.path],
          effort: "medium",
          skills: ["github-actions", ...profile.languages.slice(0, 1).map((l) => l.name.toLowerCase())],
          approach: [
            "Open the failing run, read the log of the failed step, and classify: environment rot (runner, tool version), flaky test, or a real regression.",
            "Reproduce locally with the workflow's commands; for environment rot fix the workflow, for a regression fix the code with a test.",
            `Reference the run URL in the PR and note how long ${profile.defaultBranch} has been red.`,
          ],
          acceptanceCriteria: [`${wf.name} is green on ${profile.defaultBranch} after the change.`, "The fix addresses the cause, not just the symptom (no blanket skips)."],
          etiquette: ["Check recent issues and PRs for someone already working on CI before starting.", ...(fixInFlight ? [`PR #${fixInFlight.number} may already address it.`] : [])],
          risks: [
            secretBound ? `"${wf.name}" ${secretNote}; ask a maintainer for the failing step's log before investing, since the cause may be a token only they can renew.` : "The failure may be an external service outage or a secret-only job that forks cannot run.",
            ...(stable ? [] : ["A single failure may be flaky; re-run or check the next run before investing."]),
          ],
          signals: {
            value: (stable ? 0.8 : 0.55) * (peripheral ? 0.75 : 1),
            valueReason: `${stable ? "default branch has been red for multiple runs; every contributor is blocked from trusting CI" : "one failed run; could be transient"}${peripheral ? "; only auxiliary jobs (benchmark, nightly, docs) are failing" : ""}`,
            feasibility: secretBound ? 0.3 : jobs.length ? 0.65 : 0.5,
            feasibilityReason: secretBound ? `the workflow ${secretNote}, so only maintainers can verify a fix` : jobs.length ? "failing job and step identified from the run" : "cause unknown until the log is read",
            confidence: stable ? 0.9 : 0.65,
            confidenceReason: "run conclusions come from the Actions API",
            novelty: fixInFlight ? 0.3 : 0.85,
            noveltyReason: fixInFlight ? `open PR #${fixInFlight.number} looks like a CI fix` : "no open PR looks like a CI fix",
            welcomenessFactor: 1.05,
            welcomenessReason: "a green build is in every maintainer's interest",
          },
        });
      } else if (wf.rerunsToGreen >= 2 && wf.runs.length >= 8) {
        const examples = wf.runs.filter((r) => r.conclusion === "success" && r.attempt > 1).slice(0, 3);
        findings.push({
          kind: "test_gap",
          clusterKey: `ci-flaky:${wf.path}`,
          title: `Investigate flaky "${wf.name}" runs that needed re-runs to pass`,
          summary: `${wf.rerunsToGreen} of the last ${wf.runs.length} successful ${wf.name} runs on ${profile.defaultBranch} only passed after a manual re-run, which usually means a flaky test or a racy step.`,
          evidence: examples.map((r) => evidence(ctx, "workflow_run", r.url, { note: `succeeded on attempt ${r.attempt}, ${r.updatedAt.slice(0, 10)}` })),
          files: [wf.path],
          effort: "medium",
          skills: ["testing", ...profile.languages.slice(0, 1).map((l) => l.name.toLowerCase())],
          approach: ["Open the failed first attempts and find the test or step that fails intermittently.", "Reproduce by running the test repeatedly; fix the race, timing assumption or shared state.", "Avoid retries as the fix unless the project already uses them deliberately."],
          acceptanceCriteria: ["The identified test passes reliably across repeated runs and CI stops needing re-runs for it."],
          risks: ["Re-runs can also come from infrastructure outages rather than flaky tests."],
          signals: {
            value: 0.5, valueReason: "flaky CI wastes maintainer time and masks real failures",
            feasibility: 0.5, feasibilityReason: "needs log reading and repeated local runs",
            confidence: 0.6, confidenceReason: "re-run counts are facts; the cause is not identified yet",
            welcomenessFactor: 0.95,
          },
        });
      }
    }
    return findings;
  },
};
