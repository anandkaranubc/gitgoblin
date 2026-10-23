<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/banner-dark.svg">
    <img alt="gitgoblin" src="brand/banner-light.svg" width="560">
  </picture>
</p>

# gitgoblin

**Find open-source projects worth your time, work out what they really need, and turn that into a pull request a maintainer would be glad to merge.**

[Website](https://anandkaranubc.github.io/gitgoblin/) · [Getting started](docs/getting-started.md) · [Use it from your agent](docs/agents.md) · [Contributing](CONTRIBUTING.md)

gitgoblin is a free, open-source companion for contributing to other people's software. It is for anyone who wants their open-source time to count: a first contribution, a project to learn from or depend on, or a quiet project worth reviving. It digs through public repositories for work that matters, shows the evidence, and helps you do that work to the project's own standards.

> **Status: preview.** Discovery and analysis work today; preparing a contribution with an AI agent is experimental. Nothing is on npm yet, so the command runs from a clone, and the MCP server installs from a GitHub release. See [what works today](#what-works-today).

## Why

Finding somewhere to contribute usually means sorting by stars and searching for "good first issue". That surfaces the same crowded projects everyone else found, and misses the quiet library your own app depends on, the tool whose CI broke last month, and the docs that stopped matching the code two releases ago.

gitgoblin looks for those instead. It ranks projects against what you want, reads a repository the way a careful new maintainer would, and only proposes work it can back with evidence. When it writes code, the project's own tests have to pass, an independent reviewer checks the change, and nothing is published until you say so.

## How it works

1. **Discover.** Rank public repositories for a goal (contribute, learn, adopt, revive, explore), with filters for language, topic and stars, or "more like this one". Every result says why it ranked where it did.
2. **Understand.** Profile a repository: what it is, how it is built and tested, how it treats outside contributors, and which conventions it follows.
3. **Find the work.** List concrete opportunities, each with evidence you can check: issues nobody is working on, CI about to break, docs that contradict the code, tests missing where the code changes most.
4. **Contribute.** For one opportunity, an AI agent investigates, plans, implements, runs the project's checks against a baseline, and gets an independent review. You read the result and decide whether to open the pull request.

## Try it

You need [Node.js](https://nodejs.org) 24 or newer and git. Run it from a clone:

```sh
git clone https://github.com/anandkaranubc/gitgoblin.git
cd gitgoblin
npm install
npx gitgoblin discover contribute --language typescript
```

That prints ten ranked repositories with the reasons behind each ranking. To see every signal for one repository:

```
$ npx gitgoblin explain BurntSushi/ripgrep --goal adopt
BurntSushi/ripgrep  ★ 69k · Rust · Unlicense  score 0.73
goal: adopt

activity              █████████░ 0.92 +0.05  last change today, 178 pull requests in the past year
responsiveness        ██░░░░░░░░ 0.16 −0.04  issues close in ~25 days, pull requests in ~45 days
busFactor             ██████░░░░ 0.58 +0.01  406 contributors, top committer wrote 70%
```

No configuration is needed; a GitHub token, or a `gh` login, raises the rate limit and adds data. [docs/getting-started.md](docs/getting-started.md) goes from here to analyzing a repository and preparing a contribution.

## Use it from your AI agent

gitgoblin also runs as an MCP server, so the agent you already use can discover repositories, analyze them and brief you on one piece of work. For Claude Code:

```sh
claude mcp add gitgoblin -- npx -y https://github.com/anandkaranubc/gitgoblin/releases/download/mcp-v0.1.3/gitgoblin-mcp-0.1.3.tgz
```

[docs/agents.md](docs/agents.md) has the command for Codex, Cursor, Gemini CLI, VS Code and other clients, says which ones were checked, and covers the skill that teaches agents when to use the tools. Do not use `npx -y @gitgoblin/mcp` until that npm name is published: `npx -y` runs whatever package first claims it.

## What works today

| What | Commands | Status |
| --- | --- | --- |
| Rank repositories for a goal and explain each ranking | `discover`, `explain`, `goals` | Works |
| Profile a repository and find evidence-backed work | `analyze` | Works; scores are still being calibrated |
| Prepare a contribution with an AI agent, then publish it after you approve | `contribute`, `runs`, `show`, `publish` | Experimental; needs an Anthropic API key or Claude Code login, and each run costs money |
| MCP server and agent skill | | Released on GitHub and listed in the MCP Registry |

GitHub repositories only, for now. Developed on macOS and tested on Linux in CI; Windows is untested. [docs/architecture.md](docs/architecture.md) explains how the packages fit together, and [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.

## How gitgoblin behaves in other people's projects

Maintainers did not ask for gitgoblin, so it holds itself to three rules:

- **A person approves every external action.** Nothing is pushed, opened, or commented without someone reading it and saying yes, from their own account.
- **The project's rules win.** Contributing guides, templates, rules that ask for an issue before a pull request, contributor license agreements (CLA) and sign-offs (DCO), and "we don't want this kind of change" are read and followed. Projects that do not take outside contributions are left alone.
- **One good contribution beats ten mediocre ones.** Small, tested, evidence-backed changes. No sweeps, no spam.

The full policy, including how maintainers can opt their project out, is in [docs/etiquette.md](docs/etiquette.md).

## Documentation

- [docs/getting-started.md](docs/getting-started.md): install, discover, and read the results
- [docs/agents.md](docs/agents.md): connect gitgoblin to Claude Code, Codex, Cursor, Gemini CLI, VS Code and other agents
- [docs/architecture.md](docs/architecture.md): how the packages fit together and the ideas they share
- [docs/etiquette.md](docs/etiquette.md): how gitgoblin treats the projects it contributes to
- [CONTRIBUTING.md](CONTRIBUTING.md): working on gitgoblin itself
- [SECURITY.md](SECURITY.md): reporting vulnerabilities and the boundaries we defend
- [packages/engine/README.md](packages/engine/README.md): using the contribution engine; its design is in [docs/design.md](packages/engine/docs/design.md)
- [CHANGELOG.md](CHANGELOG.md): what changed in each release

## Contributing

Bug reports, confusing-documentation reports, and pull requests are all welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); it covers setup, how changes are reviewed, and how we feel about AI-assisted contributions (short version: welcome, with you accountable for them). Everyone participating agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE).
