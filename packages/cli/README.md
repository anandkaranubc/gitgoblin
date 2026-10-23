# gitgoblin

Find open-source projects worth your time, work out what they need, and prepare a pull request
you approve. Needs [Node.js](https://nodejs.org) 24 or newer and git.

```sh
npm install -g gitgoblin
gitgoblin discover contribute --language rust
gitgoblin explain BurntSushi/ripgrep --goal adopt
gitgoblin analyze jd/tenacity
```

`npx gitgoblin <command>` works without installing. The commands follow the journey: `discover`
finds repositories, `analyze` works out what one needs, and `discover` (in a terminal) and `analyze`
end by saying what to type next.

`contribute` is experimental: an AI agent drafts one change in a local clone, and it asks before
running the agent, before implementing the plan, and before publishing anything. It needs the Claude
Agent SDK next to the CLI (`npm install -g gitgoblin @anthropic-ai/claude-agent-sdk`) and costs money
per run. `runs`, `show` and `publish` come back to a prepared change later.

More: [getting started](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/getting-started.md),
[how gitgoblin behaves in other people's projects](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/etiquette.md),
[source](https://github.com/anandkaranubc/gitgoblin). To run it from a clone of the repository
instead, `npm install` at the root and use `npx gitgoblin`; the bundling is described under
[Packaging](#packaging).

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
stderr, with the `contribute` command for the best one. If the repository's issues could not be read
(GitHub refused the request, for example), it says so and why, because most
opportunities come from issues; `contribute` shows the same line above its list.

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
There is no flag to skip any of them. When the engine reports that the repository's install failed or that checks were already failing before any change, the plan question says so, because a change implemented then cannot be verified against the project's own checks.

| Option | Meaning |
| --- | --- |
| `--report <file>` | Reuse a report from `analyze --json --out` instead of analyzing again. Refused if it is for another repository. |
| `--opportunity <id>` | Work on this opportunity: its id from the report, or its rank in the list. |
| `--issue <n>` | Work on the opportunity for this issue number. |
| `--max-cost <usd>` | Spending cap for the agent run in dollars (default: the engine's own limit, 10). A run that stops at the cap leaves nothing to publish, so a cap below what a run needs only wastes money; orientation alone has cost $1 to $2 on real repositories. |
| `--workdir <dir>` | Where runs and clones live (default `$GITGOBLIN_WORKDIR` or `~/.gitgoblin`). |
| `--model <id>`, `--effort <level>` | Model and effort for the engine; effort is `low`, `medium`, `high`, `xhigh` or `max`. |
| `--check-isolation <mode>` | How the repository's own install and test commands run on your machine: `auto` (default, an OS sandbox when one is available), `sandbox` (required), `strict` (required, and your home directory is hidden except toolchains and caches; use it for repositories you do not trust) or `none`. Anything but the default is stated in the first question. |
| `-g, --goal <goal>` | Discovery goal used for the hints. |

Without `--opportunity` or `--issue` it lists the opportunities, best first, with
kind, score, effort, id and the first piece of evidence, and marks the ones the
engine will refuse at intake: an issue someone is already working on, a triage
item that needs a reply rather than a patch, a pull request that needs its
author's consent first. When intel has a specific reason to doubt a finding (its
confidence is below 0.5, for example because code an issue quotes is gone from the
default branch), a `?` line shows that reason. Press Enter to take the first
opportunity the engine would accept and intel does not doubt; a typo gets you
asked again.

While the engine works, its phases and tool calls stream to stderr. When it
finishes you see the run's report (verification against the project's own
checks, the independent review, cost), the proposed pull request title and
description, and the path of the diff. Read the diff before answering yes. If you
answer no, the change stays in the run directory and `gitgoblin publish <runId>`
opens it later. The exit code is 1 when the run failed; a run the engine stopped
or escalated exits 0 and says why. When the repository's install failed, the end
of its log is printed under the status, since it usually names the cause.

### `gitgoblin runs`, `show`, `publish`, `clean`

The lifecycle of prepared changes, in the same workdir `contribute` uses
(`--workdir` or `$GITGOBLIN_WORKDIR` on each).

- `runs` lists every run, newest first: id, status, cost, repository, task, and
  for a run awaiting approval the command that publishes it.
- `show <runId>` prints the run's report; `--diff` prints the prepared change as
  a patch, `--pr` the pull request title and description, `--install` the output
  of the repository's install command.
- `publish <runId>` shows the pull request text and the paths to the diff and
  report, asks, then pushes with your `gh` login (to a fork when you cannot push
  to the repository) and opens a draft pull request. `--ready` opens it ready for
  review instead. Only a run whose status is `awaiting_approval` can be published.

- `clean <runId...>` frees what a finished run holds on disk: its workspace (a clone with
  the project's installed dependencies, often several hundred megabytes) and, for a
  worktree, its `gitgoblin/...` branch. The report, diff, pull request text and every
  artifact stay, so `show` still works. `clean --finished` does this for every run that
  is not awaiting approval; `--force` also discards a prepared change. `runs` says when
  finished runs still keep their workspaces.

Read [docs/etiquette.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/etiquette.md) before publishing to someone else's project.

## Exit codes

`0` success, `1` runtime failure (printed as `error: ...` on stderr, with advice
for rate limits), `2` usage error.

## Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN` | GitHub authentication. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | Model access for `contribute` (or a Claude Code login). |
| `GITGOBLIN_CACHE_DIR`, `XDG_CACHE_HOME` | Cache directory (see `cache`). |
| `GITGOBLIN_WORKDIR` | Where the engine keeps runs and clones for `contribute`, `runs`, `show` and `publish` (default `~/.gitgoblin`). |
| `NO_COLOR` | Disable colors. |

## How the sibling packages are loaded

`analyze` imports `@gitgoblin/intel`, and `contribute` and `publish` import
`@gitgoblin/engine`, only when they run. The CLI is type-checked against those
packages' exported contracts (`AnalysisReport`, `RunOptions`, `RunResult`,
`Reporter`), and reads a run directory only through the layout
`packages/engine/README.md` documents.

## Packaging

The npm package is built by `scripts/bundle.mjs`, which `npm pack` runs. It inlines
core, sources, discovery, intel and the engine, because Node will not run
TypeScript from `node_modules` and the sibling packages are not published on their
own. The installed package has no dependencies, so `discover`, `explain` and
`analyze` work straight after install.

The engine is a separate chunk that loads only for `contribute` and `publish`,
because it imports the Claude Agent SDK. The SDK is not bundled: its licence does
not allow redistribution, and its platform binary is several hundred megabytes. It
is an optional peer dependency instead. Without it, those two commands print the
install line:

```sh
npm install -g gitgoblin @anthropic-ai/claude-agent-sdk
```

The package carries this repository's `LICENSE` and `dist/THIRD_PARTY_NOTICES.md`
for the code it bundles (generated by the root `scripts/notices.mjs`).
`test/package.test.ts` builds the bundle and runs it from a directory with no
`node_modules`.
