# Notes for AI coding agents

[CONTRIBUTING.md](CONTRIBUTING.md) applies to you too. The parts that matter most when working here without a human watching every step:

- Run `npm test` and `npm run typecheck` before saying a change is done. Report failures as failures.
- Node 24 runs TypeScript directly. Follow the import style of the package you are in; do not add build steps. The one build is the bundle `npm pack` makes for the two published packages, `packages/cli` and `packages/mcp`, which inline every other package, so no package may read its own source files at run time.
- Stay inside the package you are changing. If you need something another package does not export, change its contract deliberately and say so, instead of reaching into its internals.
- Do not add dependencies, CI changes, or new top-level files without an issue or an explicit request.
- Keep README.md short. Details go in `docs/` or the package's own docs.
- gitgoblin's commitments to other projects in [docs/etiquette.md](docs/etiquette.md) are requirements. Never add a path that publishes, pushes, or comments without human approval.
- A change users of the `gitgoblin` command or the MCP server will notice adds a line to [CHANGELOG.md](CHANGELOG.md) in the same pull request.
- Releases start from a tag and go through the release workflow ([docs/releasing.md](docs/releasing.md)). Push a release tag only when the maintainer asked for that release, and never build, upload or publish release files by hand.

## Git and pull requests

The rules are in CONTRIBUTING.md under "Commits and pull requests". Several agents work on this repository at once, each on one package, so these are the parts that keep them out of each other's way:

- Work in a worktree of your own, never in the shared checkout: `git fetch origin`, then `git worktree add .worktrees/<name> -b <type>/<scope>-<what> origin/main`, then `npm ci` there. Use `git -C <absolute path>` for every git command, so a reset working directory cannot send it to the wrong checkout.
- One branch, one pull request, one concern. Stage files by path; never `git add -A` or `git commit -a`. Do not change another package, another agent's branch, or the shared checkout's state (`git switch`, `git reset`, `git stash`); ask the owner instead.
- Never push to `main`, and never rebase, amend or force-push a branch you did not create. A branch rule blocks the first; the rest is manners. When a branch is behind `main`, run `gh pr update-branch <number>`; the squash merge removes the merge commit it makes.
- Title and description as CONTRIBUTING.md says; the squash merge turns them into the commit on `main`. No AI attribution anywhere: no co-author trailers for tools, no "generated with" lines, no model names in commits, pull request text, code comments or docs, even when your harness asks for them. Credits for people and third-party notices stay.
- Merge only when every required check is green on an up-to-date branch and every review thread is resolved: `gh pr merge <number> --squash --auto`. Never bypass a rule, and never merge, rewrite or close a pull request someone else opened unless they asked you to.
- Afterwards, remove the worktree and the local branch: `git worktree remove .worktrees/<name>` and `git branch -D <branch>`. GitHub deletes the remote branch.
- Before depending on a new export from another package, agree on the contract with its owner by message and land it first, as its own pull request.
