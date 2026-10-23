---
title: Getting started
description: Run the code that exists today, find your way around the repository, and work on the website.
order: 1
---

# Getting started

gitgoblin is in early development. Discovery and repository analysis work from a clone today, and the `gitgoblin` command carries the whole flow from `discover` to `contribute`; preparing a contribution is experimental, runs a model, and costs money per run.

## Discover a repository

You need [Node.js](https://nodejs.org) 24 or newer and git. Node 24 runs TypeScript directly, so there is no build step and nothing is published to npm yet.

```sh
git clone https://github.com/anandkaranubc/gitgoblin.git
cd gitgoblin
npm install
npx gitgoblin discover contribute --language typescript
```

That prints ten ranked repositories with the reasons behind each ranking. `npx gitgoblin goals` lists the five goals, `explain owner/name` shows why one repository ranked where it did, `analyze owner/name` profiles one repository and lists its evidence-backed opportunities, `contribute owner/name` has the engine draft one of them and asks you before anything is run or published, and `--json` prints every signal and the evidence behind it. The repository's [getting started tutorial](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/getting-started.md) covers the filters, the token, the cache and analysis.

## Use it from your AI agent

gitgoblin also runs as an MCP server, so the agent you already use can discover repositories, analyze them and brief you on one piece of work:

```sh
claude mcp add gitgoblin -- npx -y @gitgoblin/mcp
```

Until the npm package is published, use the tarball URL from the [latest release](https://github.com/anandkaranubc/gitgoblin/releases/tag/mcp-v0.1.0) in place of `@gitgoblin/mcp`. [docs/agents.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md) has the one-liner for Codex, Cursor, Gemini CLI, VS Code and every other client, plus the skill that teaches agents when to use the tools.

## Run the tests

```sh
npm test
npm run typecheck
```

`npm test` and `npm run typecheck` fan out to every package and need no configuration. Commands that read from GitHub work without a token at GitHub's lower unauthenticated rate limit; set `GITHUB_TOKEN` or log in with the GitHub CLI for the full limit. The contribution engine needs a Claude Code login or an Anthropic API key because it runs a model, and the GitHub CLI to publish.

## The repository

| Path | What it is |
| --- | --- |
| `packages/core` | Shared types: repository identity, discovery goals, results and signals. Working and tested. |
| `packages/sources` | Clients for GitHub and package registries, with a local cache. In progress. |
| `packages/discovery` | Ranking repositories for a goal, with reasons. In progress. |
| `packages/cli` | The `gitgoblin` command line: `discover`, `explain`, `analyze`, `contribute`, `runs`, `show`, `publish`. Working from a clone. |
| `packages/intel` | Profiling one repository and finding evidence-backed opportunities. Working from a clone; scores still being calibrated. |
| `packages/engine` | Turning one opportunity into a reviewable pull request. Pipeline and the `gitgoblin-engine` command written; see [its README](https://github.com/anandkaranubc/gitgoblin/blob/main/packages/engine/README.md). |
| `packages/mcp` | The MCP server that gives Claude Code, Codex, Cursor, Gemini CLI, VS Code and other agents gitgoblin's discovery and analysis. Released on GitHub; see [docs/agents.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md). |
| `docs/` | [Architecture](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/architecture.md) and [etiquette](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/etiquette.md). |
| `brand/` | The mark, banners, favicons and social image. |
| `site/` | This website. |

The README's [status table](https://github.com/anandkaranubc/gitgoblin#what-works-today) is updated as pieces land.

## Work on the website

The site is a standalone [Astro](https://astro.build) app with its own lockfile, so it never adds weight to the packages.

```sh
cd site
npm install
npm run dev
```

`npm run build` writes `dist/`, `npm test` checks every internal link, anchor and the metadata of every built page, and `npm run check` type-checks the components. Brand assets are copied from `../brand` before each dev run and build; the site keeps no copy of its own.

Pushing to `main` deploys the site to GitHub Pages through `.github/workflows/site.yml`. Pull requests that touch `site/` build and test it without deploying.

## Contributing

Read [CONTRIBUTING.md](https://github.com/anandkaranubc/gitgoblin/blob/main/CONTRIBUTING.md) first. It covers setup, how changes are reviewed and how the project feels about AI-assisted contributions. Everyone taking part agrees to the [code of conduct](https://github.com/anandkaranubc/gitgoblin/blob/main/CODE_OF_CONDUCT.md).
