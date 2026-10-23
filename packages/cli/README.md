# gitgoblin (CLI)

The command-line front door to gitgoblin. Runs from source on Node 24; no build step.

```sh
npm install                      # from the repository root
npx gitgoblin discover contribute --language rust
npx gitgoblin explain BurntSushi/ripgrep --goal adopt
npx gitgoblin analyze jd/tenacity
npx gitgoblin contribute jd/tenacity
```

The commands follow the journey: `discover` finds repositories, `analyze` works out what one
needs, `contribute` has the engine draft one change and asks you before anything is published,
and `runs`, `show` and `publish` let you come back to a prepared change later. `discover` (in a
terminal) and `analyze` end by saying what to type next.

A GitHub token is optional. Without one you get 10 searches per minute, 60 API
calls per hour, and no starter-issue data. Set `GITHUB_TOKEN` or `GH_TOKEN`, or
run `gh auth login`, for 30 searches per minute, 5000 calls per hour and the
full signal set. The token is read from the environment on each run and never
written to disk.

## Commands

### `gitgoblin discover [goal]`

Ranks repositories for a goal and says why. Goals: `contribute`, `learn`,
`adopt`, `revive`, `explore` (default). `gitgoblin goals` describes them.

| Option | Meaning |
| --- | --- |
| `-l, --language <name>` | Programming language. Repeatable or comma-separated; up to three are searched. |
| `-t, --topic <name>` | GitHub topic. Repeatable; all must match. |
| `-k, --keyword <text>` | Free-text search terms. Repeatable. |
| `--min-stars <n>`, `--max-stars <n>` | Star bounds. Override the goal's defaults. |
| `--pushed-within <days>` | Only repositories pushed in the last N days. |
| `--created-within <days>` | Only repositories created in the last N days. |
| `--license <spdx>` | Require a license, e.g. `mit`, `apache-2.0`. |
| `--include-archived`, `--include-forks` | Keep archived repositories or forks. |
| `--exclude-owner <owner>` | Skip an owner. Repeatable. |
| `--like <repo>` | "More like this": uses the seed's topics, package keywords or description instead of the goal's search slices. |
| `-n, --limit <n>` | Results to show (default 10, max 100). |
| `--seed <n>` | Random seed; makes `explore` reproducible. The seed used is printed on stderr. |
| `--json` | JSON instead of text. |
| `-v, --verbose` | Progress and GitHub rate limits on stderr. |

Text output, per result: rank, `owner/name`, stars, language, license, score,
description, URL, up to three reasons that helped (`+`), the one that hurt most
(`−`), and for `contribute` up to two open starter issues. In a terminal it ends
with the `analyze` command for the top result.

JSON output is `{ query, results }` where each result is a `DiscoveryResult`
from `@gitgoblin/core`: `repo`, `goal`, `score` (0..1, comparable within a
goal), `reasons[]` (`signal`, `weight`, `detail`), `signals`, `evidence`, and
`issues[]` when available.

Examples:

```sh
gitgoblin discover contribute -l typescript -t cli --max-stars 2000
gitgoblin discover revive -l python
gitgoblin discover adopt --like sindresorhus/p-limit
gitgoblin discover explore --seed 1234 --json | jq '.results[].repo.url'
```

### `gitgoblin explain <repo> [--goal g] [--json]`

Every signal for one repository with a bar, its value, its weight for the goal
(`+`/`−`, zero means observed but not weighted), and the evidence behind it.
Default goal: `contribute`.

### `gitgoblin goals [--json]`

Lists goals, what each optimizes for, and the signals it weighs.

### `gitgoblin cache [stats|clear|prune]`

The HTTP cache lives at `$GITGOBLIN_CACHE_DIR/http-cache.sqlite`, else
`$XDG_CACHE_HOME/gitgoblin/`, else `~/.cache/gitgoblin/`. `prune` removes
entries that expired more than a week ago.

### `gitgoblin analyze <repo>`

Deep analysis through `@gitgoblin/intel`: repository profile, conventions and
contribution opportunities, rendered as Markdown. Discovery's result for the
repository is passed along as hints. When opportunities were found it ends, on
stderr, with the `contribute` command for the best one.

| Option | Meaning |
| --- | --- |
| `-g, --goal <goal>` | Discovery goal used for the hints (default `contribute`). |
| `--local <path>` | Analyze an existing checkout at this path instead of cloning. |
| `--max <n>` | Maximum opportunities in the report (default 15). |
| `--no-links`, `--no-deps` | Skip link checking or dependency and vulnerability checks. |
| `--out <file>` | Write the report to a file. |
| `--json` | The raw `AnalysisReport` instead of Markdown. `--json --out report.json` saves what `contribute --report` reads. |
| `-v, --verbose` | Analysis progress on stderr. |

### `gitgoblin contribute <repo>`

One opportunity, end to end: analyze (or reuse a saved report), choose, let
`@gitgoblin/engine` investigate, plan, implement, verify and review the change in
a local clone, read what it did, and open a draft pull request only after you
say so. It needs an interactive terminal, and asks three times: before running
the agent (it costs money), before implementing the plan, and before publishing.
There is no flag to skip any of them.

| Option | Meaning |
| --- | --- |
| `--report <file>` | Reuse a report from `analyze --json --out` instead of analyzing again. Refused if it is for another repository. |
| `--opportunity <id>` | Work on this opportunity: its id from the report, or its rank in the list. |
| `--issue <n>` | Work on the opportunity for this issue number. |
| `--max-cost <usd>` | Spending cap for the agent run (default 2). |
| `--workdir <dir>` | Where runs and clones live (default `$GITGOBLIN_WORKDIR` or `~/.gitgoblin`). |
| `--model <id>`, `--effort <level>` | Model and effort for the engine; effort is `low`, `medium`, `high`, `xhigh` or `max`. |
| `-g, --goal <goal>` | Discovery goal used for the hints. |

Without `--opportunity` or `--issue` it lists the opportunities, best first, with
kind, score, effort, id and the first piece of evidence, and marks the ones the
engine will refuse at intake: an issue someone is already working on, a triage
item that needs a reply rather than a patch, a pull request that needs its
author's consent first. Press Enter to take the first one it would accept (or the
first one, when it would refuse them all); a typo gets you asked again.

While the engine works, its phases and tool calls stream to stderr. When it
finishes you see the run's report (verification against the project's own
checks, the independent review, cost), the proposed pull request title and
description, and the path of the diff. Read the diff before answering yes. If you
answer no, the change stays in the run directory and `gitgoblin publish <runId>`
opens it later. The exit code is 1 when the run failed; a run the engine stopped
or escalated exits 0 and says why.

### `gitgoblin runs`, `gitgoblin show <runId>`, `gitgoblin publish <runId>`

The lifecycle of prepared changes, in the same workdir `contribute` uses
(`--workdir` or `$GITGOBLIN_WORKDIR` on each).

- `runs` lists every run, newest first: id, status, cost, repository, task, and
  for a run awaiting approval the command that publishes it.
- `show <runId>` prints the run's report; `--diff` prints the prepared change as
  a patch, `--pr` the pull request title and description.
- `publish <runId>` shows the pull request text and the paths to the diff and
  report, asks, then pushes with your `gh` login (to a fork when you cannot push
  to the repository) and opens a draft pull request. `--ready` opens it ready for
  review instead. Only a run whose status is `awaiting_approval` can be published.

Read [docs/etiquette.md](../../docs/etiquette.md) before publishing to someone else's project.

## Exit codes

`0` success, `1` runtime failure (printed as `error: ...` on stderr, with advice
for rate limits), `2` usage error.

## Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN` | GitHub authentication. |
| `GITGOBLIN_CACHE_DIR` | Cache directory. |
| `GITGOBLIN_WORKDIR` | Where the engine keeps runs and clones for `contribute`, `runs`, `show` and `publish` (default `~/.gitgoblin`). |
| `NO_COLOR` | Disable colors. |

## How the sibling packages are loaded

`analyze`, `contribute` and `publish` import `@gitgoblin/intel` and
`@gitgoblin/engine` when they run, so `discover` and `explain` keep working in an
install without them. The CLI is type-checked against those packages' exported
contracts (`AnalysisReport`, `RunOptions`, `RunResult`, `Reporter`), and reads a
run directory only through the layout `packages/engine/README.md` documents.
