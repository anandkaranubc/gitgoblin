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
- `contribute` (experimental) has an AI agent investigate, plan, implement and verify one
  opportunity in a local clone, gets an independent review, and prepares a pull request. It asks
  before running the agent, before implementing the plan, and before publishing; nothing is pushed
  or posted without that last yes. `runs`, `show` and `publish` come back to prepared changes later.
- The repository's own install and test commands run in an OS sandbox (`sandbox-exec` on macOS,
  `bwrap` on Linux when installed).
- `contribute --check-isolation strict` also hides your home directory from those commands, except
  toolchains and caches; use it for repositories you do not trust. The chosen mode is stated in the
  first question, before anything runs.
- Works without configuration. A GitHub token, or a `gh` login, raises rate limits and adds
  starter-issue data.

Needs Node.js 24 or newer and git. `contribute` also needs the Claude Agent SDK, installed next to the
CLI (`npm install -g gitgoblin @anthropic-ai/claude-agent-sdk`), and an Anthropic API key or Claude
Code login. Each run costs money, capped by `--max-cost`. Known limits: `discover`, `contribute` and
`publish` work with GitHub only; opportunity scores are still being calibrated; `contribute` has been
tested on a small number of real repositories.

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
