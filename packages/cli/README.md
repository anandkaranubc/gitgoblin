# gitgoblin (CLI)

The command-line front door to gitgoblin. Runs from source on Node 24; no build step.

```sh
npm install                      # from the repository root
npx gitgoblin discover contribute --language rust
npx gitgoblin explain BurntSushi/ripgrep --goal adopt
```

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
(`−`), and for `contribute` up to two open starter issues.

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
repository is passed along as hints.

| Option | Meaning |
| --- | --- |
| `-g, --goal <goal>` | Discovery goal used for the hints (default `contribute`). |
| `--max <n>` | Maximum opportunities in the report (default 15). |
| `--no-links`, `--no-deps` | Skip link checking or dependency and vulnerability checks. |
| `--out <file>` | Write the report to a file. |
| `--json` | The raw `AnalysisReport` instead of Markdown. |
| `-v, --verbose` | Analysis progress on stderr. |

### `gitgoblin contribute <repo> [--issue n] [--max-cost usd] [--workdir dir]`

End to end: analyze with `@gitgoblin/intel`, pick an opportunity, let
`@gitgoblin/engine` draft a change locally, show the proposed pull request, and
publish a draft only after you answer `y` at the prompt. Needs an interactive
terminal. There is no flag to skip the approval.

## Exit codes

`0` success, `1` runtime failure (printed as `error: ...` on stderr, with advice
for rate limits), `2` usage error.

## Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN` | GitHub authentication. |
| `GITGOBLIN_CACHE_DIR` | Cache directory. |
| `GITGOBLIN_WORKDIR` | Where the engine keeps `contribute` runs and clones (default `~/.gitgoblin`). |
| `NO_COLOR` | Disable colors. |
