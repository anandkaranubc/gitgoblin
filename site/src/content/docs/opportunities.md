---
title: What it finds
description: The twelve kinds of opportunity, the evidence behind each, how scores decompose into factors, and how a project's welcomeness is judged.
order: 3
---

# What it finds

An opportunity is one concrete, evidence-backed piece of work worth doing in a repository. The shape is a contract in [`packages/intel/src/contracts.ts`](https://github.com/anandkaranubc/gitgoblin/blob/main/packages/intel/src/contracts.ts), validated with Zod wherever data crosses a process boundary. This page is the readable version.

## Kinds

| Kind | Meaning |
| --- | --- |
| `issue` | An open issue worth fixing. |
| `feature_request` | A maintainer-endorsed feature request with no implementation underway. |
| `stale_pr` | An abandoned pull request with maintainer interest, worth reviving. |
| `triage` | An unanswered issue that needs reproduction or an answer. |
| `ci_rot` | CI that will break or has broken: deprecated actions, retired runners, unsafe triggers. |
| `deprecation` | Use of deprecated or removed APIs and libraries. |
| `dependency` | Vulnerable or deprecated dependencies. |
| `docs_drift` | Documentation that contradicts the code. |
| `broken_link` | Dead links or references in documentation. |
| `test_gap` | Frequently changed code with no tests, or tests that are skipped. |
| `tech_debt` | Self-admitted technical debt with enough context to act on. |
| `hygiene` | Missing project scaffolding that the repository's nature warrants. |

## What every opportunity carries

- **Evidence**, at least one piece. Each has a kind (`file`, `commit`, `issue`, `pull_request`, `workflow_run`, `http`, `api` or `computed`), a locator such as `path:line`, a URL or a commit SHA, a short verbatim excerpt, and when it was observed.
- **Factors** with a score from 0 to 1 and a reason each: `value` (benefit if done), `feasibility` (can an outsider realistically do it), `welcomeness` (will the maintainers want and review it), `confidence` (how sure the finding is real) and `novelty` (nobody else is already doing it). The overall score is a weighted aggregate used only for ranking.
- **Effort**: trivial, small, medium or large.
- **Skills** needed, such as `python`, `github-actions` or `docs`, and the **files** to read first.
- An **issue reference** when there is one, including whether someone already appears to be working on it.
- The **approach** a contributor would take, the **acceptance criteria**, the **etiquette** the project expects (comment first, sign a CLA, follow the template) and the **risks** of wasted work.

## Welcomeness

How a project treats outside contributors matters as much as what needs doing. Intel scores it and names a level:

| Level | Meaning |
| --- | --- |
| `closed` | Archived, a read-only mirror, or explicitly not accepting contributions. |
| `dormant` | Alive on paper, but nobody responds. |
| `selective` | Maintained, but outside work is merged rarely or under strict rules. |
| `open` | Maintained and responsive; outside pull requests get merged. |
| `eager` | Actively asks for help and merges outsiders quickly. |

Behind the level sit the signals that produced it, each with evidence, and the project's contribution rules as read from its own files: whether an issue is required first, CLA or DCO, templates, whether tests or a changelog entry are expected, the labels it uses to invite help, the kinds of change it says it does not want, and whether a bot already handles dependency updates.

## What gets dropped

An analysis report also lists the findings it skipped and why, and the budget it spent (API requests, HTTP checks, time) with a flag if analysis was cut short. A ranking you cannot audit is a bug.
