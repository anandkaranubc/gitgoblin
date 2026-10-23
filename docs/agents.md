# Use gitgoblin from your AI coding agent

gitgoblin runs as a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so the agent you already use can find open-source projects worth your time, understand what a repository needs, and hand you an evidence-backed piece of work to start on. Claude Code, Codex, Cursor, Gemini CLI, Copilot in VS Code and every other MCP client speak to the same server.

> **Where this stands (October 2026).** The server ships from [GitHub release `mcp-v0.1.2`](https://github.com/anandkaranubc/gitgoblin/releases/tag/mcp-v0.1.2) as an npm tarball and a Claude Desktop bundle, and is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.anandkaranubc/gitgoblin) as `io.github.anandkaranubc/gitgoblin`. The `@gitgoblin/mcp` package is not on npm yet, so until it is, replace `npx -y @gitgoblin/mcp` in every command below with `npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.2/gitgoblin-mcp-0.1.2.tgz`. Nothing else changes; for Claude Code that is:
>
> ```sh
> claude mcp add gitgoblin -- npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.2/gitgoblin-mcp-0.1.2.tgz
> ```

You need [Node.js](https://nodejs.org) 24 or newer and git. No account, no token, no configuration. A GitHub token is optional and explained below.

## Connect

One line per agent. Each registers the same stdio server.

| Agent | Command |
| --- | --- |
| Claude Code | `claude mcp add gitgoblin -- npx -y @gitgoblin/mcp` |
| Codex | `codex mcp add gitgoblin -- npx -y @gitgoblin/mcp` |
| Gemini CLI | `gemini mcp add -s user gitgoblin npx -y @gitgoblin/mcp` |
| VS Code | `code --add-mcp '{"name":"gitgoblin","type":"stdio","command":"npx","args":["-y","@gitgoblin/mcp"]}'` |
| Cursor | [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gitgoblin&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnaXRnb2JsaW4vbWNwIl19) or the JSON below in `.cursor/mcp.json` |

Everything else takes the standard block, in whichever file your client reads (the [table below](#other-clients) lists them):

```json
{
  "mcpServers": {
    "gitgoblin": {
      "command": "npx",
      "args": ["-y", "@gitgoblin/mcp"]
    }
  }
}
```

The first start downloads the package, which can take ten to twenty seconds; after that it is cached.

## Teach your agent when to use it

The MCP server gives your agent the tools. The gitgoblin **skill** teaches it when to reach for them, how to read the results, and how to behave in someone else's repository once you decide to act. It follows the [Agent Skills](https://agentskills.io) format, so one command installs it into whichever agents you use:

```sh
npx skills add anandkaranubc/gitgoblin
```

Claude Code users can take the plugin instead, which bundles the server and the skill:

```
/plugin install gitgoblin --marketplace anandkaranubc/gitgoblin
```

## Try it

Ask in your own words:

- "Find me a Rust project where a newcomer could land a change this week."
- "Is `jd/tenacity` healthy enough to depend on? Compare it with `litl/backoff`."
- "I want to help with `BurntSushi/ripgrep`. What does it actually need?"
- "Something widely used in Python that has gone quiet and could use a maintainer."

The agent will call `discover_repositories`, then `analyze_repository` on whichever repository you pick, then `get_opportunity` for the briefing on one item. Every number comes with the evidence behind it; ask to see it.

## The tools

All four only read public data from github.com, gitlab.com and codeberg.org. Nothing is written anywhere except a local cache under `~/.cache/gitgoblin`. Because your agent picks the repository, the server treats every repository as hostile: committed symlinks are checked out as plain files, git only speaks HTTPS, external links are never fetched, and the agent is told that text quoted from a repository is data, not instructions.

| Tool | What it does | Time |
| --- | --- | --- |
| `discover_repositories` | Ranks repositories for a goal (`contribute`, `learn`, `adopt`, `revive`, `explore`) with filters for language, topic, stars, license, recency or "more like this one". Each result explains its ranking. | up to 40 s cold, instant cached |
| `explain_repository` | Every signal for one repository under a goal, with its weight and evidence. | a few seconds |
| `analyze_repository` | Profile of one repository (what it is, how alive, how it treats outsiders, its rules, install and test commands, conventions) plus ranked opportunities with evidence. | seconds to a minute |
| `get_opportunity` | The full briefing for one opportunity: evidence with excerpts, approach, acceptance criteria, files to read, etiquette, and how to work on the project. | instant after an analysis |

[packages/mcp/README.md](../packages/mcp/README.md) documents the inputs and outputs in detail.

## GitHub token (optional)

Without a token GitHub allows 60 requests per hour and 10 searches per minute, enough to try things out. With one you get 5000 requests per hour, 30 searches per minute, and starter-issue data for the `contribute` goal. The server finds a token in `GITHUB_TOKEN`, then `GH_TOKEN`, then the [GitHub CLI](https://cli.github.com)'s login (`gh auth login`). It needs no permissions beyond reading public repositories, is read when the server starts, and is never written to disk.

Most clients pass environment variables through:

```sh
claude mcp add gitgoblin -e GITHUB_TOKEN=ghp_... -- npx -y @gitgoblin/mcp
codex mcp add gitgoblin --env GITHUB_TOKEN=ghp_... -- npx -y @gitgoblin/mcp
gemini mcp add -s user -e GITHUB_TOKEN=ghp_... gitgoblin npx -y @gitgoblin/mcp
```

Or in JSON: `"env": { "GITHUB_TOKEN": "ghp_..." }`. If you are logged in with the GitHub CLI you can skip all of this.

## Client details

### Claude Code

`claude mcp add` stores the server for the current project by default (`--scope local`). Use `--scope user` to have it everywhere, or `--scope project` to write a `.mcp.json` your team shares. `/mcp` inside a session shows the connection; `claude mcp list` does the same from the shell. The gitgoblin repository itself ships a `.mcp.json`, so a clone offers the server to anyone who opens it. [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### Claude Desktop

Download [`gitgoblin.mcpb`](https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.2/gitgoblin.mcpb) from the release and open it; Claude Desktop shows the install dialog (or use Settings → Extensions → Advanced settings → Install Extension). The bundle asks for an optional GitHub token and declares Node.js 24 or newer. Alternatively, Settings → Developer → Edit Config opens `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows); paste the standard block and restart. The Anthropic directory distributes local servers as Claude Code plugins, which is why gitgoblin ships one.

### Codex

`codex mcp add` writes `~/.codex/config.toml`; a project can override it in `.codex/config.toml`:

```toml
[mcp_servers.gitgoblin]
command = "npx"
args = ["-y", "@gitgoblin/mcp"]
env_vars = ["GITHUB_TOKEN"]
```

Codex gives servers ten seconds to start by default. If the first `npx` download is slow on your connection, raise it once with `startup_timeout_sec = 30` under the same table. [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp).

### Cursor

Project: `.cursor/mcp.json`; everywhere: `~/.cursor/mcp.json`; both take the standard block. Cursor expands `${env:GITHUB_TOKEN}` inside `env`. The install button above opens Cursor with the server pre-filled. [Cursor MCP docs](https://cursor.com/docs/context/mcp).

### Gemini CLI and Antigravity

`gemini mcp add` writes to the project's `.gemini/settings.json` unless you pass `-s user` for `~/.gemini/settings.json`. The `mcpServers` entry takes the standard block. Check the connection with `/mcp` inside a session: in Gemini CLI 0.64, `gemini mcp list` labels every configured server "Disabled" without trying to start it, so that label says nothing about the server. [Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/).

Google moved individual accounts from Gemini CLI to the Antigravity CLI in June 2026. There, `agy mcp add gitgoblin npx -y @gitgoblin/mcp` writes `~/.gemini/config/mcp_config.json` (or a project's `.agents/mcp_config.json`) with the same `mcpServers` block; `agy mcp list` shows it. [Antigravity MCP docs](https://antigravity.google/docs/mcp).

### VS Code

`code --add-mcp` adds the server to your user profile. For a workspace, put this in `.vscode/mcp.json`:

```json
{
  "servers": {
    "gitgoblin": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gitgoblin/mcp"]
    }
  }
}
```

Or click [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=gitgoblin&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40gitgoblin%2Fmcp%22%5D%7D). Copilot's agent mode lists the tools under the tools picker. [VS Code MCP docs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### Other clients

Same standard block, different file:

| Client | File |
| --- | --- |
| Zed | `settings.json`, under `context_servers` |
| Windsurf / Devin Desktop | `~/.codeium/windsurf/mcp_config.json` (older) or `~/.config/devin/mcp_config.json` |
| Cline | `cline_mcp_settings.json` via the MCP Servers panel |
| Roo Code | `.roo/mcp.json` or the global `mcp_settings.json` |
| OpenCode | `opencode.json`, as `"mcp": { "gitgoblin": { "type": "local", "command": ["npx", "-y", "@gitgoblin/mcp"] } }` |
| Goose | `~/.config/goose/config.yaml`, as an `extensions` entry with `cmd: npx`, `args: [-y, "@gitgoblin/mcp"]` |
| Amp | `amp mcp add gitgoblin -- npx -y @gitgoblin/mcp` |
| JetBrains AI Assistant / Junie | Settings → Tools → AI Assistant → MCP, paste the block; Junie also reads `.junie/mcp/mcp.json` |
| Kiro | `.kiro/settings/mcp.json` |
| Warp | `~/.warp/.mcp.json` or Settings → Agents → MCP servers |
| Continue | `.continue/mcpServers/gitgoblin.yaml` with `type: stdio`, `command: npx`, `args: [-y, "@gitgoblin/mcp"]` |

If your client is not listed, it almost certainly accepts the standard block too. Open an issue if it does not.

## From a clone

For development, run the server from the repository:

```sh
git clone https://github.com/anandkaranubc/gitgoblin.git
cd gitgoblin && npm install
claude mcp add gitgoblin -- node "$PWD/packages/mcp/bin/gitgoblin-mcp.mjs"
```

The launcher runs the TypeScript source directly on Node 24; there is nothing to build. `npm test -w @gitgoblin/mcp` runs the protocol tests offline, and `GITGOBLIN_E2E=1 npx vitest run --root packages/mcp test/e2e` talks to GitHub through the real server.

## When something goes wrong

- **"needs Node.js 24 or newer"**: the server checks on start and says which version it found. Install Node 24 or newer, or point the client at it with the full path to `node`.
- **The first call times out**: a cold `discover_repositories` can take 40 seconds while it asks GitHub and ecosyste.ms about each candidate. The server reports progress, so clients that reset their timeout on progress keep waiting. Run it again; the second search is instant from the cache. Narrow filters (one language, a star cap) also speed it up.
- **Rate limited**: the error says when the limit resets and how to add a token. See [GitHub token](#github-token-optional).
- **A repository is "not found"**: check the spelling, whether it moved, and that it is public. Private repositories are out of scope.
- **"not one of the forges gitgoblin reads"**: the tools accept github.com, gitlab.com and codeberg.org. For a self-hosted forge you trust, set `GITGOBLIN_MCP_HOSTS=git.example.org` in the server's environment (for example `claude mcp add gitgoblin -e GITGOBLIN_MCP_HOSTS=git.example.org -- npx -y ...`).
- **Something printed on stdout broke the connection**: the server routes all its logging to stderr. If you see this, it is a bug; please report it with the client and the command.

The cache lives at `~/.cache/gitgoblin` (`$XDG_CACHE_HOME/gitgoblin`, or `$GITGOBLIN_CACHE_DIR`). Deleting it is always safe.

## What has been verified

Checked on macOS on 22 and 23 October 2026. "Release" means the tarball or bundle attached to a GitHub release (`mcp-v0.1.0` for the client checks, later versions where the row says so); "clone" means the launcher run from the repository.

| Client | Checked | Result |
| --- | --- | --- |
| `npx` from the release URL | Cold run in an empty directory, 0.1.0, 0.1.1 and 0.1.2 | Installs in under two seconds, answers `initialize` and `tools/list`, nothing but JSON-RPC on stdout; 0.1.1 refuses `169.254.169.254` as a repository host |
| Claude Code 2.1.309 | `claude mcp add` with the 0.1.0, 0.1.1 and 0.1.2 release URLs and with a clone, `claude mcp list` | Connected, four tools listed |
| Codex 0.163.0 | `codex mcp add` with the 0.1.0, 0.1.1 and 0.1.2 release URLs and with a clone, then headless `codex exec` turns | Codex called `explain_repository` through the server and answered from its result; on 0.1.1 and 0.1.2 an `analyze_repository` call for `https://10.0.0.5/team/app` was refused and Codex reported the refusal |
| Cursor CLI (`agent`) | `.cursor/mcp.json` with a clone, `agent mcp enable`, `agent mcp list-tools` | All four tools listed with their arguments; `agent mcp list` reports the server ready |
| VS Code 1.139.1 | `code --add-mcp` | Entry written to the user profile `mcp.json`; connection not exercised |
| Gemini CLI 0.64.0 | `gemini mcp add -s user`, `gemini mcp list` | Registered. `mcp list` labels every server Disabled without connecting, and this machine's account can no longer run Gemini CLI, so the connection was not exercised |
| Antigravity CLI 1.4.5 | `agy mcp add` with the release URL, `agy mcp list` | Registered and enabled; the headless turn hit the account's quota, so the connection was not exercised |
| Agent Skills | `npx skills add anandkaranubc/gitgoblin --list` | Finds the `gitgoblin` skill in the public repository |
| Claude Code plugin | `claude plugin validate`, install from a local marketplace | Installs with the skill and the server inventoried |
| MCPB bundle | `mcpb validate`, `mcpb pack`, unpack and run the launcher | Initializes and lists the tools; not installed in Claude Desktop itself |
| Cursor and VS Code one-click links | Encoded and decoded | Point at `@gitgoblin/mcp`, so they work once the npm package exists |
| MCP Registry | `mcp-publisher publish` from the repository's GitHub Actions workflow, which fails unless the registry then lists the version | `io.github.anandkaranubc/gitgoblin` listed as active, pointing at the newest release's `.mcpb`; superseded versions marked deprecated |

Anything not in this table has not been tried here.
