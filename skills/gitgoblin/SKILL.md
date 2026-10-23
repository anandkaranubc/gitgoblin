---
name: gitgoblin
description: Find open-source projects worth contributing to, learning from, adopting or reviving, understand what a repository actually needs, and pick an evidence-backed piece of work. Use when someone asks where to contribute, wants a good first issue or a project to learn from, asks whether a library is healthy or maintained, or wants to help a specific repository and does not know what to do there. Uses the gitgoblin MCP tools when connected and explains how to connect them otherwise.
license: MIT
compatibility: Works best with the gitgoblin MCP server connected (installed from a gitgoblin GitHub release). Needs Node.js 24 and git on the machine; a GitHub token is optional. Discovers on GitHub; analyzes GitHub, GitLab and Codeberg repositories.
metadata:
  author: gitgoblin
  homepage: https://github.com/anandkaranubc/gitgoblin
---

# gitgoblin

gitgoblin finds open-source work worth doing and explains why, with evidence a person can check. It ranks repositories for a goal instead of by stars, profiles a repository the way a careful new maintainer would, and surfaces concrete opportunities: unclaimed issues, endorsed feature requests, stale pull requests worth reviving, CI about to break, deprecated APIs, vulnerable dependencies, docs that contradict the code, dead links, untested hot code.

## When to reach for it

- "Where should I contribute?", "find me a good first issue in Rust", "a project to learn from"
- "Is this library maintained?", "should we depend on X?", "compare X and Y"
- "I want to help with owner/name, what needs doing?"
- "Something abandoned but widely used that I could revive"

Not for: private repositories, or making changes for the person. gitgoblin only reads. The work itself happens in your normal tools, with the person deciding what gets published.

## The tools, in order

All four are read-only MCP tools from the `gitgoblin` server.

1. `discover_repositories` — goal plus filters. Goals: `contribute` (active, welcoming, newcomer can land a change), `learn` (well documented, mature), `adopt` (maintained, widely used), `revive` (valuable but quiet), `explore` (interesting, little known). Start with a goal and one language; add `topics`, `max_stars` (to escape the famous projects), `like` (more like a repository the person already likes). A cold search takes up to 40 seconds.
2. `explain_repository` — every signal for one repository under a goal, with evidence. Use it to answer "is X healthy" or to compare candidates.
3. `analyze_repository` — profile plus ranked opportunities for one repository on GitHub, GitLab or Codeberg. Clones it (blob-less) and reads manifests, CI, docs, issues and pull requests. Takes a few seconds to a minute.
4. `get_opportunity` — the full briefing for one item: evidence with excerpts, approach, acceptance criteria, files to read, the project's install and test commands, conventions, rules and etiquette.

If the tools are not available, say so and offer the one-line setup for the person's agent (below) rather than guessing at repositories.

## Reading the results

- **Scores** run from 0 to 1 and compare only within one goal. A 0.6 under `revive` and a 0.6 under `contribute` mean different things.
- **Reasons and evidence** are the point. Quote them to the person instead of the number: "last change yesterday, 282 pull requests merged this year" beats "score 0.90".
- **Unknown is not zero.** A signal gitgoblin could not measure is left out, not counted against the repository.
- **Welcomeness** (`closed`, `dormant`, `selective`, `open`, `eager`) says how the project treats outsiders. Do not propose contributions to `closed` projects; warn before `dormant` ones.
- **Opportunities are leads, not orders.** Each carries the factors behind its score (value, feasibility, welcomeness, confidence, novelty). Low confidence means "inferred from text alone": verify before investing time.

Present a short list: repository, one line on why it fits, the strongest evidence, and the next step. Offer `analyze_repository` on whichever the person picks.

## Acting on an opportunity

The person has picked something and wants to do it. gitgoblin's etiquette toward other people's projects applies to you now:

1. **Re-check the issue or pull request** for comments, assignees or linked work newer than the analysis. If someone has claimed it, pick something else.
2. **Read the project's contributing guide** and the briefing's rules: issue first, CLA or DCO, tests, changelog, PR template, commit style. Follow them even when they slow you down.
3. **Work the way the project works.** Clone it, run its own install and test commands from the briefing, match its conventions and typical pull request size. One change, finished, tested.
4. **Never publish on the person's behalf.** Do not open issues, pull requests or comments, push, star or fork unless the person explicitly asks for that specific action, from their own account, after reading the change. Prepare the branch and the pull request text; they decide.
5. **Disclose AI assistance** in the pull request description, as gitgoblin's etiquette commits to, and follow the project's policy on AI-assisted contributions, including a refusal.
6. **Quiet projects get one careful contribution,** easy to merge or easy to ignore, never a stream.

## Connecting the server

One line per agent; all run the same stdio server from the tarball attached to the latest gitgoblin release (https://github.com/anandkaranubc/gitgoblin/releases). The commands below name release 0.1.2; use the newest one listed there.

```sh
claude mcp add gitgoblin -- npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.6/gitgoblin-mcp-0.1.6.tgz          # Claude Code
codex mcp add gitgoblin -- npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.6/gitgoblin-mcp-0.1.6.tgz           # Codex
gemini mcp add -s user gitgoblin npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.6/gitgoblin-mcp-0.1.6.tgz     # Gemini CLI
```

Cursor, VS Code and other clients take the standard JSON block:

```json
{ "mcpServers": { "gitgoblin": { "command": "npx", "args": ["-y", "https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.6/gitgoblin-mcp-0.1.6.tgz"] } } }
```

Never substitute `npx -y @gitgoblin/mcp`: that npm name is not published yet, and `npx -y` would run whatever package first claims it.

A GitHub token is optional. `GITHUB_TOKEN`, `GH_TOKEN`, or a GitHub CLI login (`gh auth login`) raises the limits and unlocks starter-issue data. The full install guide with every client is at https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md.
