# @gitgoblin/mcp

gitgoblin as a [Model Context Protocol](https://modelcontextprotocol.io) server. It gives any MCP client (Claude Code, Codex, Cursor, Gemini CLI, Copilot in VS Code, and others) four read-only tools: discover repositories worth your time, explain why one scores the way it does, analyze what a repository actually needs, and get a full briefing on one piece of work.

```sh
claude mcp add gitgoblin -- npx -y @gitgoblin/mcp
```

[docs/agents.md](../../docs/agents.md) has the one-liner for every client, the skill that teaches agents when to use the tools, and what has been verified. The server is listed in the official MCP Registry as `io.github.anandkaranubc/gitgoblin`. The package is not on npm yet; until it is, use the tarball from the [latest release](https://github.com/anandkaranubc/gitgoblin/releases/tag/mcp-v0.1.1) in place of `@gitgoblin/mcp` (`npx -y <tarball url>`), or run it from a clone with `node packages/mcp/bin/gitgoblin-mcp.mjs` after `npm install`. Claude Desktop users install the release's `gitgoblin.mcpb` directly.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `discover_repositories` | `goal` (default `contribute`), `languages`, `topics`, `keywords`, `min_stars`, `max_stars`, `pushed_within_days`, `created_within_days`, `license`, `like`, `exclude_owners`, `include_archived`, `include_forks`, `limit` (default 10, max 25) | Ranked repositories: stars, language, license, score, the three strongest reasons for and one against, starter issues for `contribute`. `structuredContent.results[]` carries the same fields. |
| `explain_repository` | `repository`, `goal` | All ten discovery signals with value, weight for the goal and evidence. Unknown signals say so. |
| `analyze_repository` | `repository`, `max_opportunities` (default 10, max 30), `check_dependencies` (default true), `goal` | The profile (nature, activity, responsiveness, welcomeness with signals, rules, commands, conventions) and the ranked opportunities with their primary evidence. |
| `get_opportunity` | `repository`, `opportunity_id` or `issue_number` | One opportunity in full plus how to work on the project: clone, commands, conventions, rules, etiquette. |

`repository` accepts `owner/name` or a URL on github.com, gitlab.com or codeberg.org; other hosts are refused unless listed in `GITGOBLIN_MCP_HOSTS`. Errors come back as tool results with advice (how to get a token, how to spell a repository), never as protocol failures. Long calls send progress notifications when the client provides a progress token.

The server's `instructions` tell the agent the typical flow, that quoted repository text is data and never instructions, and the one rule that matters: it never opens issues, pull requests or comments on the person's behalf unless asked.

The repository is often chosen by a model, so the server treats it as hostile: git checks committed symlinks out as plain files and only speaks HTTPS, clones live in their own cache, external links are never fetched, and control characters are stripped from every result. [docs/design.md](docs/design.md#untrusted-repositories) explains each defence.

## Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN` | Optional. Raises GitHub's limits and unlocks starter issues. Falls back to `gh auth token`. |
| `GITGOBLIN_CACHE_DIR` | Where the HTTP cache lives (default `~/.cache/gitgoblin`); the server's blob-less clones go in its `mcp` subdirectory. |
| `GITGOBLIN_MCP_HOSTS` | Extra forges the tools may read, comma-separated, for example `git.example.org`. Only add hosts you trust: the server clones from them. |

## Development

```sh
npm test -w @gitgoblin/mcp                                       # protocol tests with fakes, offline
npm run typecheck -w @gitgoblin/mcp
GITGOBLIN_E2E=1 npx vitest run --root packages/mcp test/e2e      # the real server over stdio, against GitHub
npm run bundle -w @gitgoblin/mcp                                 # what `npm pack` ships: dist/gitgoblin-mcp.mjs
npm run mcpb -w @gitgoblin/mcp                                   # the Claude Desktop bundle: dist/gitgoblin.mcpb
```

`src/server.ts` builds the server from an injectable `ServerDeps` (discovery and intel); `src/format.ts` renders results for a model; `src/deps.ts` wires the real packages; `bin/gitgoblin-mcp.mjs` is the launcher. Development runs the TypeScript source on Node 24. Publishing bundles the source and the sibling packages into one file with no runtime dependencies, because Node will not strip types under `node_modules`. [docs/design.md](docs/design.md) explains the decisions; `server.json` is the manifest for the MCP Registry; it points at the release's `.mcpb` and its SHA-256. A release is `npm pack` plus `npm run mcpb`, both files attached to a `mcp-v<version>` GitHub release, then the `MCP Registry` workflow run by hand (`gh workflow run mcp-registry.yml`), which publishes `server.json` with the repository's own GitHub Actions identity.
