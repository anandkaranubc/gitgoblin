---
title: How it works
description: The four stages, the contribution engine's pipeline, and the rules that decide when it continues, retries, asks a human or stops.
order: 2
---

# How it works

gitgoblin is a set of small packages that hand each other plain data. Four stages take you from "what do I want" to a pull request you can read and approve.

## The four stages

1. **Discover.** Given a goal (contribute, learn, adopt, revive or explore) and filters such as language or topic, rank public repositories and explain each ranking. A score is only comparable within the same goal, and a missing signal means unknown, never zero.
2. **Understand.** Given one repository, build a profile: what kind of project it is, its ecosystems and tooling, the commands a contributor would run, activity and bus factor, how it treats outside contributors, and the conventions it follows.
3. **Find the work.** From the profile and the repository's issues, CI, docs and code, produce a ranked list of concrete opportunities. Every one carries evidence a person can check and a score that decomposes into named factors with reasons. Findings that were dropped are listed too, with the reason, so the ranking can be audited.
4. **Contribute.** Take one opportunity through the engine below. Stop and hand over to a human the moment approval is needed.

[docs/architecture.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/architecture.md) describes the packages and the contracts between them.

## The engine pipeline

The engine turns one validated opportunity into one reviewable pull request, or stops with a clear reason. It optimises for contributions a maintainer would merge, not for throughput.

| Phase | Who does it | What it produces |
| --- | --- | --- |
| intake | code | A `Task`: the few fields the engine reads from the profile and the opportunity |
| workspace | code | A clone or worktree at the profiled commit, on a new branch |
| baseline | code | The project's own test, lint and typecheck results before anything is touched |
| orient | agent, sandboxed; may write a reproduction test | An investigation: where the code is, whether the problem reproduces, whether it is feasible |
| plan | the same agent session | A change plan: files, steps, tests to add, what is out of scope, risks |
| implement | the same session, with write access | The diff, with tests added or updated |
| verify | code | The project's checks again, compared with the baseline |
| review | a fresh agent, read-only | A sceptical review that never sees the implementer's transcript |
| prepare | code | A commit in the project's style, `pr.md` and `report.md`; status `awaiting_approval` |
| approve | a person | Yes or no |
| publish | code, with the person's own GitHub login | A fork if needed, a push, a pull request |

Orient, plan and implement share one agent session so the implementer keeps the reasons behind its decisions. Review runs in a fresh session because independence is the point of a second reader. Verification compares against the baseline so a check only counts as regressed if it passed before and fails now; pre-existing failures are never blamed on the change.

Every phase writes its artifact to the run's directory (`~/.gitgoblin/runs/<runId>/` for the `gitgoblin` command), plus an `events.jsonl` log, so a run can be inspected or published later.

## When it continues, retries, asks or stops

A pure, unit-tested policy module is the only place that decides what happens next:

- Orient says the work is not feasible, the premise is wrong or it is already fixed: **stop**, with the reasons.
- Orient needs a human, or the plan touches more files than the limit or a protected path (CI workflows, release config, secrets): **escalate** with written questions.
- Verification fails: **retry** implementation with the failure output, up to a limit. The same failure twice in a row counts as a loop and escalates.
- Review asks for changes: **retry** with the findings, up to a limit. A blocker that survives a revision escalates; a rejection escalates.
- The budget (money or wall clock) is exceeded at any gate: **stop**.

Escalations and stops still write a full report, so a person can pick up where the engine left off.

## Not in version 0.1

Finding or ranking opportunities is the job of discovery and intel, not the engine. The engine runs one task at a time, uses the Agent SDK sandbox rather than a container, and does not react to CI results or maintainer review after the pull request is open. The interfaces allow all of these later.

The complete design, with the prior art it borrows from, is in [packages/engine/docs/design.md](https://github.com/anandkaranubc/gitgoblin/blob/main/packages/engine/docs/design.md).
