# Getting started

This takes you from a fresh clone to a ranked list of repositories, then to a report on one repository with concrete work to do. It takes about ten minutes. Preparing a pull request from that report is described at the end.

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

Useful flags: `--json` prints the full report as data (the input the contribution engine takes), `--out report.md` writes it to a file, `--max 5` caps the number of opportunities, and `--no-links` and `--no-deps` skip the slower external link and dependency checks. To analyze a checkout you already have, use the intel package's own command: `npx gitgoblin-intel analyze --local ./path`. Issue and pull request analysis needs a GitHub token (step 5); without one the report still covers the code and says what it skipped.

## What comes next

**Prepare a contribution.** The engine that investigates, implements, verifies, reviews, and prepares a pull request runs from its own package today and has completed an end-to-end run on a test repository with a real model. It takes the JSON report from step 7 and one opportunity id. It is experimental, costs money per run, and needs an Anthropic API key or Claude Code login, a git identity, and the GitHub CLI for publishing. [packages/engine/README.md](../packages/engine/README.md) has the commands. Read [etiquette.md](etiquette.md) before publishing anything to someone else's project.
