---
title: Status
description: What exists today, what is being built, and what is deliberately left for later. Updated as pieces land.
order: 5
---

# Status

gitgoblin is in early development, built in the open. Discovery and repository analysis work from a clone today and from any MCP client through the server released on GitHub; preparing a contribution is experimental. Nothing is published to npm, and no single command runs the whole flow yet. This page is kept honest by hand; when it disagrees with the [README's status table](https://github.com/anandkaranubc/gitgoblin#what-works-today), the README wins.

Last updated 2026-10-22.

## What exists

| Part | Package | Status |
| --- | --- | --- |
| Shared types: repository identity, discovery goals and signals | `packages/core` | Working |
| Clients for GitHub and package registries, with a local cache | `packages/sources` | Working |
| Ranking repositories for a goal, with reasons | `packages/discovery` | Working |
| The `gitgoblin` command: `discover`, `explain`, `goals`, `cache` | `packages/cli` | Working from a clone; not published to npm |
| Repository profiling and opportunity discovery (`analyze`) | `packages/intel` | Working from a clone; scores still being calibrated |
| Plan, implement, review, verify, prepare a pull request | `packages/engine` | Runs end to end on a test repository; experimental. See [its README](https://github.com/anandkaranubc/gitgoblin/blob/main/packages/engine/README.md) |
| MCP server for Claude Code, Codex, Cursor, Gemini CLI, VS Code and other agents, plus an agent skill | `packages/mcp` | Released on GitHub (`mcp-v0.1.0`); npm publish pending. See [docs/agents.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md) |
| Brand, documentation and this website | `brand/`, `docs/`, `site/` | Live |

## Being built now

- Calibrating the scores behind `analyze`, so rankings across repositories mean the same thing.
- The end-to-end flow: discover a repository, analyze it, pick an opportunity, run the engine, approve, publish.
- The maintainer opt-out list in [docs/excluded-projects.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/excluded-projects.md), enforced in discovery and the engine rather than only by people.
- Real examples. The walkthrough on the front page is scripted from the design and the engine's command line; a recording of a real run will replace it.

## Deliberately later

- Running many tasks in parallel, or on a schedule.
- Container or VM isolation for the engine. Version 0.1 uses the Agent SDK sandbox plus hooks; the interface allows stronger isolation later.
- Reacting to CI results or maintainer review after a pull request is open.

If you want to help with any of this, start with [CONTRIBUTING.md](https://github.com/anandkaranubc/gitgoblin/blob/main/CONTRIBUTING.md).
