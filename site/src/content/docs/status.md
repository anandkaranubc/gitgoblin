---
title: Status
description: What exists today, what is being built, and what is deliberately left for later. Updated as pieces land.
order: 5
---

# Status

gitgoblin is in preview, built in the open. Discovery and repository analysis work today, from the `gitgoblin` command and from any agent that runs local MCP servers. `gitgoblin contribute` carries one opportunity on to a prepared pull request; it is experimental and costs money per run. Both install from npm: `npm install -g gitgoblin` for the command, `npx -y @gitgoblin/mcp` for the MCP server. This page is kept honest by hand; when it disagrees with the [README](https://github.com/anandkaranubc/gitgoblin#what-works-today), the README wins.

Last updated 2026-10-29.

## What works

| What | Commands | Status |
| --- | --- | --- |
| Rank repositories for a goal and explain each ranking | `discover`, `explain`, `goals` | Works |
| Profile a repository and find evidence-backed work | `analyze` | Works; scores are still being calibrated |
| Prepare a contribution with an AI agent, then publish it after you approve | `contribute`, `runs`, `show`, `publish` | Experimental; needs an Anthropic API key or Claude Code login, and each run costs money |
| MCP server and agent skill for Claude Code, Codex, Cursor, Gemini CLI, VS Code and others | | Works; on npm as `@gitgoblin/mcp` and listed in the MCP Registry; [docs/agents.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md) says which clients were checked |

`analyze` reads GitHub, GitLab and Gitea or Forgejo repositories (Codeberg among them); discovery and publishing are GitHub-only. Developed on macOS and tested in CI on Linux and Windows; on Windows, `discover`, `analyze` and the MCP server work, and `contribute` does not, because its sandbox for repository commands exists only on macOS and Linux.

## Being built now

- Calibrating the scores behind `analyze`, so rankings across repositories mean the same thing, and cutting the false positives that audits and backtests find.
- The maintainer opt-out list in [docs/excluded-projects.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/excluded-projects.md), enforced in discovery and the engine rather than only by people.
- Detecting a project's policy on AI-generated contributions. Until then, the person approving a contribution checks it by hand.
- Real examples. The walkthrough on the front page is scripted; a recording of a real run will replace it.

## Deliberately later

- Discovery and publishing on GitLab, Codeberg and self-hosted forges. Analysis already reads them; ranking and pull requests still go through GitHub.
- Running many tasks in parallel, or on a schedule.
- Container or VM isolation for the engine. Today the model runs in the Agent SDK sandbox with hooks, and the repository's own commands run in an OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux); the interface allows stronger isolation later.
- Reacting to CI results or maintainer review after a pull request is open.

If you want to help with any of this, start with [CONTRIBUTING.md](https://github.com/anandkaranubc/gitgoblin/blob/main/CONTRIBUTING.md).
