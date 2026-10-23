# Contributing to gitgoblin

Thanks for your interest. This guide covers working on gitgoblin itself. If you want to know how gitgoblin behaves inside *other* projects, read [docs/etiquette.md](docs/etiquette.md) instead.

**Short version for experienced contributors:** Node 24, `npm install`, `npm test`, `npm run typecheck`. Open an issue before large changes. Small PRs with tests. AI tools are fine; you own the result.

## Ways to help

- **Report what confused you.** If a doc, error message, or command left you unsure what to do next, that is a bug. Open an issue and quote the part that confused you.
- **Fix small things directly.** Typos, broken links, clearer wording, a missing test: open a pull request, no issue needed.
- **Propose bigger things in an issue first.** New features, behavior changes, new dependencies, and anything touching how gitgoblin acts in other people's repositories should be agreed on before you write code. This saves you from building something that cannot be merged.
- **Review.** Reading an open pull request and leaving a thoughtful comment is a real contribution.

## Setting up

You need [Node.js](https://nodejs.org) 24 or newer (`node --version`) and git. There is no other tooling to install.

```sh
git clone https://github.com/anandkaranubc/gitgoblin.git
cd gitgoblin
npm install
npm test
npm run typecheck
```

Node 24 runs TypeScript directly, so there is no build step during development; packages import each other's source. To work on one package:

```sh
npm test -w packages/core
npm run typecheck -w packages/core
```

### Repository layout

```
packages/
  core/      types and helpers every other package uses
  sources/   clients for GitHub and package registries
  discovery/ ranking repositories for a goal, with reasons
  cli/       the gitgoblin command line
  intel/     repository profiling and contribution opportunities
  engine/    plan, implement, review, verify, prepare a pull request
docs/        project-wide documentation
site/        the website, a standalone app with its own package.json
brand/       logo, banner, favicons and brand guidelines
```

`site/` is not part of the npm workspace, so the root install stays small. To work on the website run `npm install` and `npm run dev` inside `site/`. Brand assets and the rules for using them are in [brand/README.md](brand/README.md).

Packages talk to each other only through the types they export, never by reaching into each other's internals. If you need something from another package that it does not export, change the contract and say so in your pull request. [docs/architecture.md](docs/architecture.md) explains how the pieces fit.

## Making a change

- **Keep it focused.** One concern per pull request. Unrelated cleanups go in their own PR, where they are easy to review and easy to revert.
- **Add or update tests.** Every package uses [Vitest](https://vitest.dev). A change in behavior comes with a test that would have failed before it. Pure functions with injected inputs are preferred over anything that needs the network or a model to test.
- **Match the surrounding code.** Strict TypeScript, ES modules, no default exports, comments that explain *why* rather than *what*. Follow the import style of the package you are in.
- **No new dependencies without discussion.** Each one is something every user installs and every maintainer tracks.
- **Update the docs in the same PR.** If behavior changes, the documentation that describes it changes with it. Run `npm run docs:check` to catch broken links.
- **Write commit messages for the next person.** An imperative subject line under 72 characters, then a body that says why, if the why is not obvious.

### Working with AI tools

gitgoblin is built with AI assistance, and you are welcome to use AI tools for your contributions here. The rules are the same ones gitgoblin applies to itself:

- You are accountable for everything in your pull request. Read it, run it, and be able to explain any line of it in review.
- Say so in the pull request when substantial parts were generated. Nobody will think less of the contribution; it helps reviewers know where to look.
- Do not open pull requests you have not tested, and do not open several speculative PRs hoping one lands.

## Pull requests

When you open a pull request, the template asks for what changed, why, and how you tested it. Fill it in honestly; "ran `npm test`" is a fine answer when it is true.

Continuous integration runs tests and type checks on every pull request. gitgoblin is maintained by volunteers, so review may take a few days; a polite nudge after a week is welcome. Expect questions and sometimes a request to split or shrink the change. Disagreeing is fine; say why. When a discussion does not resolve itself, the maintainer makes the call and records the reasoning in the issue or the relevant design document.

## Licensing

gitgoblin is released under the [MIT License](LICENSE). By submitting a contribution you agree that it is licensed the same way. There is no contributor license agreement to sign.

## Code of conduct

Everyone participating in the project agrees to the [Code of Conduct](CODE_OF_CONDUCT.md). If something happens that should not have, it tells you how to report it privately.
