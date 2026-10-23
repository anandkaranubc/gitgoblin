# Changelog

What changed in each release of the two packages gitgoblin publishes: the `gitgoblin` command
(tags `v<version>`) and the `@gitgoblin/mcp` server (tags `mcp-v<version>`). Newest first. Versions
follow [Semantic Versioning](https://semver.org); before 1.0, a minor version may change behavior.
[docs/releasing.md](docs/releasing.md) says how a release is made.

## gitgoblin 0.1.0 - Unreleased

The first release of the `gitgoblin` command.

- `discover` ranks public GitHub repositories for a goal (`contribute`, `learn`, `adopt`, `revive`,
  `explore`) with filters for language, topic, stars, license and recency, or similarity to a
  repository you name. Every result says why it ranked where it did. `explain` shows every signal for
  one repository, with its evidence; `goals` lists what each goal weighs.
- `analyze` profiles one repository (what it is, how active it is, how it treats outside
  contributors, its install and test commands, its conventions) and lists contribution
  opportunities, each with evidence you can check. It reads GitHub, GitLab and Gitea or Forgejo
  repositories (Codeberg among them), and gives any other git host a clone-only analysis.
- `analyze` checks its own findings: an issue whose quoted code is gone from the default branch, or
  that a later commit cites, is marked as possibly fixed; a dependency update an open pull request
  already makes is skipped; code that only quotes a pattern (rule tables, test fixtures) and
  generated files are not reported. A missing repository gets a plain "not found" message.
- `analyze --llm` asks Claude for a second opinion on issue triage. It is off by default, costs
  money, and needs an Anthropic API key; the model can demote or rescue an issue but never
  overrides facts such as a merged pull request.
- Analysis treats repository content as untrusted: reads never follow symlinks out of the clone,
  link checks only contact public addresses on standard ports, and every parser of issue, README
  and source text runs in linear time, so a crafted file or issue cannot stall it.
- `contribute` (experimental) has an AI agent investigate, plan, implement and verify one
  opportunity in a local clone, gets an independent review, and prepares a pull request. It asks
  before running the agent, before implementing the plan, and before publishing; nothing is pushed
  or posted without that last yes. `runs`, `show` and `publish` come back to prepared changes later.
- When choosing what to work on, `contribute` marks opportunities the engine would refuse (`!`) and
  those intel doubts (`?`, for example an issue whose quoted code is gone, so it may already be
  fixed), and pressing Enter skips both.
- The repository's own install and test commands run in an OS sandbox (`sandbox-exec` on macOS,
  `bwrap` on Linux when installed).
- `--check-isolation strict` is the setting for repositories you do not trust: your home directory
  is hidden from the repository's commands except toolchains and caches, and on macOS the install
  can reach package registries only; hosts it tried and was refused are listed in the run report.
- Prepared pull requests are written for the maintainers who will read them: the title describes
  the fix, the summary says what changed and why, checks that already failed before the change are
  marked as such, and notes about gitgoblin's own environment stay in your run report.
- Works without configuration. A GitHub token, or a `gh` login, raises rate limits and adds
  starter-issue data.
- Errors say what to do next: an unreachable network names the host and the cause, a TLS
  certificate failure points at `NODE_EXTRA_CA_CERTS`, and a repository that does not exist is
  reported as not found rather than as an HTTP status.

Needs Node.js 24 or newer and git. `contribute` also needs the Claude Agent SDK, installed next to the
CLI (`npm install -g gitgoblin @anthropic-ai/claude-agent-sdk`), and an Anthropic API key or Claude
Code login. Each run costs money, capped by `--max-cost`. Known limits: `discover`, `contribute` and
`publish` work with GitHub only; opportunity scores are still being calibrated; `contribute` has been
tested on a small number of real repositories.

## @gitgoblin/mcp 0.1.5 - 2026-10-23

Replaces the withdrawn 0.1.4.

- Analysis parses issue text in linear time; 0.1.4 could stall for hours on a crafted issue body.
- Each analysis runs in its own worker thread and is stopped after five minutes or as soon as the
  client cancels the request, so a repository that makes analysis slow can no longer freeze the
  other tools.
- Everything 0.1.4 added stays: `analyze_repository` and `get_opportunity` read GitLab and Codeberg
  repositories, and the bundle tool is pinned in the lockfile.
- The bundle is back to about 2 MB: analysis now loads the Anthropic SDK only for its optional model
  review, which the server never turns on, so the SDK is no longer included.

## @gitgoblin/mcp 0.1.4 - 2026-10-23

**Do not install 0.1.4.** Its analysis includes a regular expression that can take minutes or hours on a crafted issue body, freezing `analyze_repository` for any repository with such an issue. Use 0.1.5.

- `analyze_repository` and `get_opportunity` read GitLab and Codeberg repositories again, now that
  analysis reads those forges through their own public APIs. Discovery and `explain_repository` still
  read GitHub only, and other hosts are still refused.
- The bundle is larger, about 3 MB, because analysis now includes the Anthropic SDK for an optional
  model review of issues. The server never turns that review on and makes no model calls.
- The tool that packs the `.mcpb` bundle is pinned in the lockfile instead of downloaded on each build.

## @gitgoblin/mcp 0.1.3 - 2026-10-23

- Reads github.com repositories only. Earlier versions also accepted gitlab.com and codeberg.org,
  but discovery and analysis look repositories up on GitHub by owner and name, so those requests
  were answered about whichever GitHub repository had the same name.
- The server instructions and the opportunity briefing tell the agent to disclose AI assistance in
  the pull request and to follow the project's policy on AI contributions.

## @gitgoblin/mcp 0.1.2 - 2026-10-23

- The package and the `.mcpb` bundle now carry gitgoblin's license and the notices of the
  third-party code they bundle. 0.1.1 shipped without them.

## @gitgoblin/mcp 0.1.1 - 2026-10-23

Security release; upgrade from 0.1.0.

- Treats the repository it analyzes as hostile, since your agent usually picks it: committed
  symlinks are checked out as plain files, git only speaks HTTPS, external links are no longer
  fetched, and repository hosts are limited to public forges.
- Strips control characters from results and tells the agent that repository text is data, not
  instructions.

## @gitgoblin/mcp 0.1.0 - 2026-10-23

First release: gitgoblin as a Model Context Protocol server with four read-only tools,
`discover_repositories`, `explain_repository`, `analyze_repository` and `get_opportunity`, plus an
agent skill and a Claude Code plugin. Do not install this version: `analyze_repository` follows
symlinks committed in the analyzed repository and can reach hosts on your network. Use 0.1.1 or later.
