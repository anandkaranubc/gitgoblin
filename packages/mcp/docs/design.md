# @gitgoblin/mcp design

gitgoblin inside an AI coding agent. This page records what the server does, the decisions behind it, and what it deliberately leaves out.

## The idea

People already have an agent: Claude Code, Codex, Cursor, Gemini CLI, Copilot in VS Code. The agent can clone, read, edit, test and open pull requests. What it cannot do is find the right project, or tell which of a project's hundred open issues is real, unclaimed and wanted. That is gitgoblin's discovery and intel work, and the Model Context Protocol (MCP) is how every one of those agents takes in outside tools.

So the server exposes gitgoblin's read-only half and stops there. It does not wrap the contribution engine: inside an agent, the agent is the engine. The hand-off is a briefing (`get_opportunity`) with everything the agent needs to start: evidence, approach, acceptance criteria, the project's own install and test commands, its conventions and its rules.

## Tools

Four tools, named as `verb_noun`, each annotated `readOnlyHint` and `openWorldHint` (they read public APIs and never write anywhere but the local cache).

| Tool | Does | Typical time |
| --- | --- | --- |
| `discover_repositories` | Ranks GitHub repositories for a goal with filters; every result explains its ranking | 5 to 40 s cold, instant when cached |
| `explain_repository` | Every signal, with evidence, for one repository under a goal | about 2 s |
| `analyze_repository` | Profile plus ranked, evidence-backed opportunities for one repository | 1 to 60 s depending on repository size |
| `get_opportunity` | One opportunity in full, plus how to work on the project | instant after an analysis |

Design rules for the tools, in order of importance:

1. **Small, readable results.** The raw `DiscoveryResult` list for ten repositories is 33 KB of JSON and an `AnalysisReport` is 25 KB. The tools return a compact text rendering written for a model (one block per result, strongest reasons only) and a compact `structuredContent` object for programs. The full opportunity is available on demand through `get_opportunity`.
2. **Zero configuration.** Everything works without a token. `GITHUB_TOKEN`, `GH_TOKEN` or a GitHub CLI login raise the rate limits and unlock starter issues, exactly as in the command line. The token is read from the environment and never stored.
3. **Progress, not silence.** Long calls send MCP progress notifications when the client provides a progress token, and logging notifications otherwise, so clients that reset their timeout on progress keep waiting and people see what is happening.
4. **Errors are advice.** A rate limit says when it resets and how to get a token. An unknown repository says how to spell one. Tool errors are returned as `isError` results, never thrown, so the agent can recover.
5. **Nothing on stdout.** The stdio transport owns stdout. The launcher redirects `console.log` to stderr before any library loads, because one stray print corrupts the protocol stream.

Goals and their descriptions live in the tool descriptions rather than in a fifth tool. Resources and prompts are not used: tool support is universal across clients, resource and prompt support is not, and nothing here needs them.

## Untrusted repositories

The repository a tool reads is usually chosen by a model, and a model can be steered by text planted in a README, an issue or an earlier result. The server therefore treats both the repository and the choice of repository as hostile:

- **Git is hardened before anything else loads.** `src/env.ts` (imported first by `main.ts`) appends `core.symlinks=false`, `protocol.allow=never` and `protocol.https.allow=always` to git's environment configuration. A committed symlink such as `README.md -> ~/.git-credentials` or `-> /dev/zero` is checked out as a small file holding the target path, so no read can leave the clone; clones can only use HTTPS. The cost: a repository whose README is itself a symlink is analyzed with the path text in place of the README until intel resolves in-repository links safely.
- **The server's clones live in their own cache** (`<cache>/mcp`), so every one was made with those settings; a clone made earlier by the command line could still hold a real symlink.
- **Only public forges are accepted** (github.com, gitlab.com, codeberg.org). Intel fetches `https://<host>/<owner>/<name>.git` as given, so any other host would let a model point the server at the person's own network. `GITGOBLIN_MCP_HOSTS` adds a self-hosted forge.
- **External links are never fetched.** Intel's link probe follows redirects to any address, so `analyze_repository` has no `check_links` option; relative links inside the repository are still checked.
- **Output is cleaned and labelled.** Control characters and bidirectional overrides are stripped from every result, and the server instructions tell the agent that quoted repository text is data, never instructions.

These live in this package so they hold regardless of what intel does; intel hardening its own reads and probes makes them defence in depth rather than redundant.

## Caching

The discovery and intel packages already cache HTTP responses and clones under `~/.cache/gitgoblin`; the server keeps its clones under `~/.cache/gitgoblin/mcp` (see above). The server adds one in-memory map of the last `AnalysisReport` per repository, kept for an hour, so `get_opportunity` is instant after `analyze_repository`. When the report is missing (a new server process, or the hour passed) the tool re-runs the analysis, which is fast on a warm cache.

## Packaging

The monorepo runs TypeScript from source on Node 24 and has no build step. That does not survive publishing: Node refuses to strip types for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `npx @gitgoblin/mcp` cannot run `.ts` files, and the sibling packages are not published on their own.

The answer is a single bundled file, produced only when packing:

- `bin/gitgoblin-mcp.mjs` is the one entry point. It checks the Node version, guards stdout, then imports `dist/gitgoblin-mcp.mjs` when it exists (an installed package) and `src/main.ts` otherwise (a clone of the repository). Development stays build-free.
- `npm pack` runs `scripts/bundle.mjs`, which uses esbuild to bundle `src/main.ts` with the workspace packages and every npm dependency into `dist/`. Node built-ins stay external. The published package therefore has no runtime dependencies, which makes `npx -y @gitgoblin/mcp` one download and a fast cold start.
- The sibling packages and the libraries they use are `devDependencies` of this package: they are inputs to the bundle, not dependencies of the published artifact. esbuild is the one new development dependency, added for this reason.

`scripts/mcpb.mjs` wraps the same launcher and bundle into an MCPB bundle (`dist/gitgoblin.mcpb`): the double-click install for Claude Desktop, and an artifact the MCP Registry accepts when it is attached to a GitHub release. Each release carries both the npm tarball from `npm pack` and the bundle, so `npx -y <tarball url>` works before, and independently of, the npm package.

`server.json` next to the package is the manifest for the official MCP Registry. It points at the release's `.mcpb` with its SHA-256; when the npm package is published, an npm entry joins it and the registry verifies ownership through the `mcpName` field in `package.json`.

## Distribution

One package, several doors:

- **Any MCP client**: the stdio server, `npx -y @gitgoblin/mcp`. The README has the exact command or config for each client, verified against the installed client where that was possible.
- **Claude Code plugin**: `.claude-plugin/plugin.json` at the repository root bundles the MCP server with the agent skill, so one `/plugin install` gives both.
- **Agent skill**: `skills/gitgoblin/SKILL.md` follows the Agent Skills format that Claude Code, Codex, Cursor, Gemini CLI and others read. It teaches the agent when to reach for gitgoblin, how to read scores and evidence, and how to behave in someone else's repository, which is the part a tool list cannot carry.
- **GitHub release**: `mcp-v<version>` carries the npm tarball and the MCPB bundle, so the server is installable from the day of a release, with or without npm.
- **Registries**: the `MCP Registry` workflow (`.github/workflows/mcp-registry.yml`, started by hand) publishes `server.json` with the repository's GitHub Actions OIDC token, which the registry accepts for `io.github.anandkaranubc/*`; no personal token is involved. Directories that ingest the registry (Glama, PulseMCP) pick the entry up from there; the ones with submission forms are a maintainer's task.

## Non-goals

- Running the contribution engine from the server. The host agent is better placed to do the work with the person watching, and the engine's approval prompts are built for a terminal.
- Any tool that writes to GitHub. gitgoblin's etiquette puts a person between the tool and every external action; an MCP tool call is not that person.
- A remote (HTTP) server. Everything runs locally against public APIs; a hosted version would need its own authentication and rate-limit story.
- Client-specific features beyond tools. Revisit when resources or prompts are surfaced by more than one or two clients.
