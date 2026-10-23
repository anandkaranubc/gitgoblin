# Contributing to gitgoblin

Thanks for your interest. This guide covers working on gitgoblin itself. If you want to know how gitgoblin behaves inside *other* projects, read [docs/etiquette.md](docs/etiquette.md) instead.

**Short version for experienced contributors:** Node 24, `npm install`, `npm test`, `npm run typecheck`. Open an issue before large changes. Small PRs with tests, squash-merged under a title like `fix(intel): skip archived repositories`. AI tools are fine; you own the result.

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
- **Write the pull request for the next person.** Its title and description become the one commit on `main`; [Commits and pull requests](#commits-and-pull-requests) says how.

### Working with AI tools

gitgoblin is built with AI assistance, and this page says so once for the whole project. You are welcome to use AI tools for your contributions here. The rules are the same ones gitgoblin applies to itself:

- You are accountable for everything in your pull request. Read it, run it, and be able to explain any line of it in review.
- A pull request needs no disclosure line, co-author trailer or tool signature, and neither do commits, code or docs. If you want reviewers to look closely at a part you did not write yourself, say which part.
- Do not open pull requests you have not tested, and do not open several speculative PRs hoping one lands.

## Commits and pull requests

Every change reaches `main` through a pull request, and pull requests are squash-merged: the commits on your branch become one commit on `main`, with the pull request title as its subject and the description as its body. Write both for the person reading `git log` next year. Nobody pushes to `main` directly, maintainers included; a branch rule enforces it.

1. **Branch from an up-to-date `main`**, named `type/scope-what-it-does`:

   ```sh
   git fetch origin
   git switch -c fix/intel-archived-repos origin/main
   ```

   From a fork, fetch `upstream` instead and push the branch to your fork.

2. **Keep it small and finished.** One concern, with its tests and docs. A change you cannot describe in one title is two pull requests. The commits on your branch can be as rough as you like; the squash merge replaces them.

3. **Title it like a commit subject**, in [Conventional Commits](https://www.conventionalcommits.org/) form: `type(scope): what the change does`, in the imperative, no final period, 72 characters at most. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore` and `revert`. The scope is the package or area: `core`, `sources`, `discovery`, `cli`, `intel`, `engine`, `site`, `brand` or `docs`. Put `!` before the colon when the change breaks a contract another package relies on. A check on every pull request reads the title and says what to fix. A future changelog will be generated from these types.

4. **Describe it in the template**: what changed and why, and how you tested it. "`npm test` and `npm run typecheck` pass" is a fine answer when it is true. That text becomes the commit body, so keep it about the change. Link the issue with `Fixes #123` when there is one.

5. **Checks must pass on a branch that is up to date with `main`**: `check` (type check, tests and docs links) and `PR title`. When `main` moves after you opened the pull request, press **Update branch** on the pull request page, or run `gh pr update-branch`, and the checks run again. Every review thread is resolved before merging.

6. **Merge.** A maintainer merges, or turns on auto-merge so GitHub merges as soon as the checks pass (`gh pr merge --squash --auto`). The branch is deleted after merging. Merge commits and rebase merges are turned off, so the history of `main` is one commit per pull request, each with a title that says what it did.

gitgoblin is maintained by volunteers, so review may take a few days; a polite nudge after a week is welcome. Expect questions and sometimes a request to split or shrink the change. Disagreeing is fine; say why. When a discussion does not resolve itself, the maintainer makes the call and records the reasoning in the issue or the relevant design document.

## Licensing

gitgoblin is released under the [MIT License](LICENSE). By submitting a contribution you agree that it is licensed the same way. There is no contributor license agreement to sign.

## Code of conduct

Everyone participating in the project agrees to the [Code of Conduct](CODE_OF_CONDUCT.md). If something happens that should not have, it tells you how to report it privately.
