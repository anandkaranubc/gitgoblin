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

- **Public repositories only.** A token (`GITHUB_TOKEN`, or the GitHub CLI's login) and a git credential helper can both reach private repositories. Before any work, `explain_repository`, `analyze_repository` and `get_opportunity` confirm with an anonymous request to the forge's API that the repository is public (GitHub falls back to the repository page when the anonymous API limit is spent), and `discover_repositories` leaves out results it cannot confirm. Its searches run with the person's token too, so they carry `is:public`, and filter values that are search syntax (`is:private`, `user:<org>`, a leading `-`, a quote, `AND`/`OR`/`NOT`) are refused: otherwise a private repository could come back from the search and have its name sent to ecosyste.ms before the check. Answers are remembered for half an hour; an unreachable forge means a refusal, never a guess.
- **Only fixed public forges are accepted.** Intel fetches `https://<host>/<owner>/<name>.git` as given, so an open host list would let a model point the server at the person's own network. Discovery and `explain_repository` read GitHub's API by owner and name, so they take github.com alone (another forge would be answered with whatever GitHub repository shares the name); analysis takes github.com, gitlab.com and codeberg.org, which intel reads through their public APIs, and skips discovery's hints for the latter two for the same reason.
- **Analysis runs in a child process with an empty home.** Each analysis is a child process started from the server's own entry module (so the bundle stays one file), in its own process group: after five minutes, or as soon as the client cancels, the whole group is killed, git included. The same happens when the server exits or is interrupted or terminated, and a child whose server disappears without a word (killed outright) stops itself and its group when its IPC channel closes. Its `HOME`, `USERPROFILE` and `XDG_CONFIG_HOME` point at an empty directory, so git reads none of the person's own configuration: no credential helper, LFS filter, alias or hook of theirs touches a hostile clone. The GitHub token is resolved by the server and passed explicitly, because the GitHub CLI cannot find its login under the empty home; intel never gives it to git. The child's heap is capped at 2 GB, at most two analyses run at once, and its stdout and stderr go to the server's stderr, never the protocol channel. Git's system-wide configuration still applies until intel's own git calls disable it.
- **Clones are kept per forge** (`<cache>/mcp/repos/<host>/<owner>/<name>`, keyed by intel), so an attacker's `codeberg.org/<owner>/<name>` can never stand in for `github.com/<owner>/<name>`, and apart from the command line's clones. An analysis holds `<name>.lock` (a file with the server's process id) while it clones and reads, so a second analysis of the same repository, from this server or another one sharing the cache, waits instead of cloning into the same directory; a lock whose process is gone is taken over. The 20 most recently used clones per forge are kept; older ones are deleted, never a locked one. Cloning gives up after four minutes, inside the analysis limit, so a slow clone fails cleanly instead of being killed mid-write.
- **Repository files are read inside the clone.** Intel resolves every path to a regular file inside the checkout, so a committed symlink such as `README.md -> ~/.git-credentials` or `-> /dev/zero` reads as nothing.
- **External links are never fetched.** `analyze_repository` has no `check_links` option, so the server never sends requests to addresses a repository names; relative links inside the repository are still checked.
- **Output is cleaned, labelled and capped.** Control and format characters (Unicode Cc and Cf, which include bidirectional overrides, zero-width characters and the invisible tag characters) are stripped from every result. Each result opens with a line saying the text that follows quotes public repositories and is data, not instructions, and the server instructions say the same. Text is capped at 20,000 characters and every string and list in structured content is capped too, so one repository cannot flood the agent's context.

These live in this package so they hold regardless of what intel does; intel hardening its own reads, probes and git calls makes them defence in depth rather than redundant.

## Caching

The discovery and intel packages already cache HTTP responses and clones under `~/.cache/gitgoblin`; the server keeps its clones under `~/.cache/gitgoblin/mcp/repos/<host>` (see above). The server adds one in-memory map of the last `AnalysisReport` per repository, kept for an hour, so `get_opportunity` is instant after `analyze_repository`. When the report is missing (a new server process, or the hour passed) the tool re-runs the analysis, which is fast on a warm cache.

## Packaging

The monorepo runs TypeScript from source on Node 24 and has no build step. That does not survive publishing: Node refuses to strip types for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `npx @gitgoblin/mcp` cannot run `.ts` files, and the sibling packages are not published on their own.

The answer is a single bundled file, produced only when packing:

- `bin/gitgoblin-mcp.mjs` is the one entry point. It checks the Node version, guards stdout, then imports `dist/gitgoblin-mcp.mjs` when it exists (an installed package) and `src/main.ts` otherwise (a clone of the repository). Development stays build-free.
- `npm pack` runs `scripts/bundle.mjs`, which uses esbuild to bundle `src/main.ts` with the workspace packages and every npm dependency into `dist/`. Node built-ins stay external. The published package therefore has no runtime dependencies, which makes `npx -y @gitgoblin/mcp` one download and a fast cold start.
- The sibling packages and the libraries they use are `devDependencies` of this package: they are inputs to the bundle, not dependencies of the published artifact. esbuild is the one new development dependency, added for this reason.

`scripts/mcpb.mjs` wraps the same launcher and bundle into an MCPB bundle (`dist/gitgoblin.mcpb`): the double-click install for Claude Desktop, and an artifact the MCP Registry accepts when it is attached to a GitHub release. Each release carries both the npm tarball from `npm pack` and the bundle, built by the release workflow from the tagged, merged commit, so `npx -y <tarball url>` works before, and independently of, the npm package. The `.mcpb` is a zip whose hash changes from build to build, so `server.json` takes its SHA-256 from the published asset (the release's `SHA256SUMS`), never from a local rebuild.

`server.json` next to the package is the manifest for the official MCP Registry. It points at the release's `.mcpb` with its SHA-256; when the npm package is published, an npm entry joins it and the registry verifies ownership through the `mcpName` field in `package.json`.

## Distribution

One package, several doors:

- **Any MCP client**: the stdio server, `npx -y @gitgoblin/mcp`, published by the release workflow with build provenance. Until the first npm release the docs installed the release tarball instead and warned against the npm name, which anyone could have claimed first. `docs/agents.md` has the exact command or config for each client and says which were connected and which only configured.
- **Claude Code plugin**: `.claude-plugin/plugin.json` at the repository root bundles the MCP server with the agent skill, so one `/plugin install` gives both.
- **Agent skill**: `skills/gitgoblin/SKILL.md` follows the Agent Skills format that Claude Code, Codex, Cursor, Gemini CLI and others read. It teaches the agent when to reach for gitgoblin, how to read scores and evidence, and how to behave in someone else's repository, which is the part a tool list cannot carry.
- **GitHub release**: `mcp-v<version>` carries the npm tarball and the MCPB bundle, so the server is installable from the day of a release, with or without npm.
- **Registries**: the `MCP Registry` workflow (`.github/workflows/mcp-registry.yml`, started by hand) publishes `server.json` with the repository's GitHub Actions OIDC token, which the registry accepts for `io.github.anandkaranubc/*`; no personal token is involved. Directories that ingest the registry (Glama, PulseMCP) pick the entry up from there; the ones with submission forms are a maintainer's task.

## Non-goals

- Running the contribution engine from the server. The host agent is better placed to do the work with the person watching, and the engine's approval prompts are built for a terminal.
- Any tool that writes to GitHub. gitgoblin's etiquette puts a person between the tool and every external action; an MCP tool call is not that person.
- A remote (HTTP) server. Everything runs locally against public APIs; a hosted version would need its own authentication and rate-limit story.
- Client-specific features beyond tools. Revisit when resources or prompts are surfaced by more than one or two clients.
