# Getting started

This takes you from a fresh clone to a ranked list of repositories, then to a report on one repository with concrete work to do. It takes about ten minutes. Step 8 turns one item of that report into a pull request you approve.

## 1. Install

You need [Node.js](https://nodejs.org) 24 or newer and git. There is no published package yet, so run it from a clone:

```sh
git clone https://github.com/anandkaranubc/gitgoblin.git
cd gitgoblin
npm install
npx gitgoblin --help
```

## 2. Pick a goal

gitgoblin ranks the same repositories differently depending on what you want. `npx gitgoblin goals` lists the five goals and the signals each one weighs:

```
contribute  Active, welcoming projects where a newcomer can land a change
learn       Well-documented, mature codebases worth reading
adopt       Maintained, widely used libraries and tools you can depend on
revive      Valuable projects that have gone quiet and could use a maintainer or fork
explore     Interesting projects most people have not seen yet
```

## 3. Discover

```sh
npx gitgoblin discover contribute --language typescript --limit 3
```

The first run takes up to half a minute while it asks GitHub and [ecosyste.ms](https://ecosyste.ms) about each candidate. Results looked like this on 22 October 2026; yours will differ:

```
 1. mvschwarz/openrig  ★ 8.1k · TypeScript · Apache-2.0  score 0.90
    Build your own network of agents from Claude Code, Codex and Pi: persistent teams…
    https://github.com/mvschwarz/openrig
    + CONTRIBUTING guide, code of conduct
    + last change today, 282 pull requests in the past year
    + README, description, homepage, changelog
```

How to read a result:

- **score** runs from 0 to 1 and is only comparable between results for the same goal.
- **`+` lines** are the strongest reasons it ranked where it did. **`−` lines** are what counted against it. Each one names the evidence, so you can check it.
- Stars, language, and license are shown for context, not because they drove the ranking.

Narrow the search with filters. The ones people reach for most:

```sh
# quiet but widely used Python projects that could use a maintainer
npx gitgoblin discover revive --language python --min-stars 200

# small, active command-line tools most people have not seen
npx gitgoblin discover explore --topic cli --max-stars 500

# projects similar to one you already like
npx gitgoblin discover learn --like BurntSushi/ripgrep
```

`explore` is the default goal when you give none. It shuffles a little on purpose and prints its seed on stderr, so you can rerun exactly the same list later with `--seed`. `--json` prints the same results as data, including every signal and the raw evidence behind it. `npx gitgoblin discover --help` lists every option, and [packages/cli/README.md](../packages/cli/README.md) is the full reference: every command, output field, exit code, and environment variable.

## 4. Explain one repository

To see every signal for a repository you already have in mind:

```sh
npx gitgoblin explain BurntSushi/ripgrep --goal adopt
```

```
BurntSushi/ripgrep  ★ 69k · Rust · Unlicense  score 0.67
goal: adopt

activity              ████░░░░░░ 0.42 −0.01  last change 3 months ago, 178 pull requests in the past year
responsiveness        ██░░░░░░░░ 0.16 −0.04  issues close in ~25 days, pull requests in ~45 days
busFactor             ██████░░░░ 0.58 +0.01  406 contributors, top committer wrote 70%
maturity              ██████████ 1.00 +0.07  created 11 years ago, 75 releases
usage                 ██████░░░░ 0.60 +0.02  used by 490 repositories via nixpkgs:ripgrep
```

Each row is one signal: its value from 0 to 1, how much it moved the score for this goal, and the evidence. A signal gitgoblin could not measure is left out rather than scored as zero.

## 5. Add a GitHub token (optional, recommended)

Everything above works without a token, but GitHub then allows only a handful of requests per minute, and the data that comes from GitHub's GraphQL API is skipped: `contribute` results show no starter issues and lose some newcomer-friendliness signals. For the full picture, do one of:

- Log in with the [GitHub CLI](https://cli.github.com): `gh auth login`. gitgoblin finds that login on its own.
- Set `GITHUB_TOKEN` or `GH_TOKEN` to a token that can read public repositories. No other permissions are needed.

gitgoblin reads the token when it runs and never writes it anywhere.

## 6. The cache

Responses from GitHub and ecosyste.ms are cached on disk, so a repeated search is instant and your rate limit lasts longer. `npx gitgoblin cache stats` shows where the cache lives and how big it is; `cache prune` drops entries that expired over a week ago; `cache clear` deletes everything. Set `GITGOBLIN_CACHE_DIR` to move it.

## 7. Analyze one repository

Once a repository looks promising, ask what it actually needs:

```sh
npx gitgoblin analyze jd/tenacity
```

This clones the repository, reads its manifests, CI, docs, issues, and pull requests, and prints a Markdown report. The first run on a repository takes up to a minute. Trimmed, it looks like this:

```
# jd/tenacity

**Nature:** library (installable Python package)
**Activity:** 29 commits / 8 authors in 90 days; bus factor 1; last push 2026-10-12
**Welcomeness:** open (0.75)
- + a fair share of outside PRs get merged — 44% of 16 recently closed PRs from non-maintainers were merged
- − issues wait over a month for an answer — median 2111h to first response on 59 outside issues

**How to work on it:**
- python (hatch), python >=3.10: install: `pip install -e ".[dev]"` · test: `pytest` · lint: `ruff check .`

**Conventions:** conventional commits, branches fix/<topic>, docs/<topic>, typical PR 17 lines, tests with pytest

## Opportunities (9)

### 1. Revive PR #663: feat: add retry_unless_exception_cause_type

`stale_pr` · score **0.69** · effort medium · skills: python

The pull request was changes requested and author went quiet. ...

Evidence:
- https://github.com/jd/tenacity/pull/663 — (changes requested and author went quiet; idle 85 days; 4 files, +135/-23)

Approach:
1. Ask in #663 whether the author minds you carrying it forward; wait a few days.
2. Rebase their branch onto the default branch, resolve conflicts, and address the review comments.

Etiquette: Never open a competing PR without asking first; credit the original author.
```

The top half is the **profile**: what the repository is, how alive it is, how it treats outsiders (each judgment with its evidence), the exact commands to install and test it, and the conventions your change should follow. The bottom half is the **opportunities**, best first. Each one names its kind (an open issue, a stale pull request, CI about to break, docs that contradict the code, and so on), the factors behind its score, evidence you can click, the steps a contributor would take, and the etiquette the project expects. Scores are still being calibrated against real repositories, so trust the evidence more than the number.

Useful flags: `--json --out report.json` saves the full report as data (what step 8 can reuse, so the repository is not analyzed twice), `--out report.md` writes the Markdown to a file, `--max 5` caps the number of opportunities, `--local ./path` analyzes a checkout you already have, and `--no-links` and `--no-deps` skip the slower external link and dependency checks. Issue and pull request analysis needs a GitHub token (step 5); without one the report still covers the code and says what it skipped. When it finds opportunities, the command ends by printing the `contribute` command for the best one.

## 8. Prepare a contribution

This is the experimental part. It runs an AI agent against a local clone, costs money per run, and needs an Anthropic API key or Claude Code login, a git identity, and the [GitHub CLI](https://cli.github.com) logged in for publishing. Read [etiquette.md](etiquette.md) first: you are about to prepare a change for someone else's project.

```sh
npx gitgoblin contribute jd/tenacity --report report.json
```

The repository's own install and test commands run on your machine in an OS sandbox when one is available. For a repository you do not trust, add `--check-isolation strict`, which also hides your home directory from them.

Without `--report` it analyzes the repository again. Without `--opportunity <id>` or `--issue <n>` it lists the opportunities and asks which one, marking any the engine would refuse (someone is already on the issue, or the item needs a reply rather than a patch):

```
Opportunities in jd/tenacity, best first:

 1. Fix #511: Unreachable code in `before_log` reached
    issue · score 0.59 · small effort · id opp-d6b43e61
    Hello, I've reached code that is marked as unreachable in before_log…
    evidence: https://github.com/jd/tenacity/issues/511 and 1 more
 2. Fix #507: Statistics can be incorrectly initialized inside Temporal contexts
    issue · score 0.56 · small effort · id opp-917f92c3
    …
    ! someone is already working on #507 (an assignee or an open pull request)

Which opportunity? [1-2, or an id; Enter for 1]
```

Then it asks three questions, and there is no flag to skip any of them:

1. **Run the agent?** It names the repository and the spending cap (`--max-cost`, default $10, the engine's own limit). Saying no costs nothing. A run that hits the cap stops with nothing to publish, so set it to what you are willing to spend on a finished change rather than lower.
2. **Implement this plan?** After investigating, the agent proposes a plan: goal, steps, files, tests. You see it in plain words before any code changes, along with a warning if the repository's install failed or its checks were already failing, since a change made then cannot be verified.
3. **Open a draft pull request?** Only after the change passed the project's own checks against a baseline and an independent review. You see the run's report, the proposed pull request title and description, and the path of the diff. Read the diff. If you say no, nothing is pushed or posted anywhere; the change stays in the run directory. (The repository's code and the issue text have already been sent to the model provider you configured, from your machine, during the run.)

Every run lives under `~/.gitgoblin/runs/<id>/` (or `$GITGOBLIN_WORKDIR`). To come back later:

```sh
npx gitgoblin runs                       # every run, newest first, with its status
npx gitgoblin show <runId>               # the report; --diff for the patch, --pr for the PR text, --install for the install log
npx gitgoblin publish <runId>            # asks, then pushes with your gh login and opens a draft PR
```

[packages/cli/README.md](../packages/cli/README.md) documents every option. The engine's own command, `gitgoblin-engine`, can drive the same runs directly when given the same directory (`--workdir ~/.gitgoblin`); [packages/engine/README.md](../packages/engine/README.md) covers that and the design behind the pipeline.
