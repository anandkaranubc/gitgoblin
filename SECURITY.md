# Security

gitgoblin reads other people's repositories, runs an AI agent against them,
and prepares pull requests. That makes a few things security-sensitive that
would not be in an ordinary CLI. This page explains how to report a problem and
what we consider one.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. If you cannot use it,
open an ordinary issue that asks the maintainer for a private contact, with no
details of the problem.

Include what you found, how to reproduce it, and what an attacker could do
with it. A proof of concept helps; a working exploit against a real
third-party repository does not, so please demonstrate against a repository
you control.

gitgoblin is maintained by volunteers. We aim to acknowledge reports within
seven days and to tell you what we plan to do within thirty. We will credit
you in the fix unless you prefer otherwise.

## Supported versions

Fixes go to `main` and into the next release of each published package, the
`gitgoblin` command and the `@gitgoblin/mcp` server. Older versions are not
patched; a release with a known vulnerability is deprecated and its release
notes name the version to upgrade to. [CHANGELOG.md](CHANGELOG.md) lists the
releases.

## What counts as a vulnerability

These are the boundaries gitgoblin is designed to hold. A way to cross any of
them is a vulnerability, even if it needs a maliciously crafted repository or
issue to trigger.

- **No external writes without a human.** The engine must never push, open a
  pull request, comment, fork, or otherwise write to a remote until a person
  has approved the prepared result.
- **The agent stays in its sandbox.** An agent working on a target repository
  must not write outside its workspace, reach the network, run privileged
  commands, or load the target repository's own agent configuration (hooks,
  settings, instruction files) as instructions it obeys.
- **The repository's own commands stay in theirs.** The install, test, lint
  and build commands the engine runs on your machine run inside an OS sandbox
  when one exists (`sandbox-exec` on macOS, `bwrap` on Linux): writes only to
  the checkout and tool caches, credential files unreadable, no network except
  during install, and then only to package registries. A change that edits
  what those commands execute (package scripts, Makefiles, test-runner
  configuration) must stop for a person before the engine runs it. A way
  around any of these is a vulnerability.
- **Credentials never reach the agent.** GitHub tokens, cloud credentials, and
  anything else beyond what the agent needs for model access must stay in the
  operator's process.
- **Untrusted text is data, not instructions.** Issue bodies, README files,
  commit messages, and code comments in target repositories can contain
  prompt injection. Content that changes what the engine does, beyond informing
  the change it was asked to make, is a bug.
- **Operator secrets stay local.** API keys and tokens must not appear in run
  artifacts, logs, commits, or pull request bodies.

Things that are not vulnerabilities on their own: a low-quality or incorrect
contribution (open a normal issue), rate limiting by GitHub, or a model
refusing to do something.

## Running gitgoblin safely

- Give it its own GitHub token with the smallest scope that works, and revoke
  the token when you are done experimenting.
- Treat every prepared pull request as untrusted until you have read the diff
  yourself. Approval is the safety boundary; use it.
- Keep the sandboxes on. Inside one, a repository's install script runs as
  you but reaches only package registries; `--install-network open` on
  `gitgoblin-engine run` lifts that for a repository that needs other hosts.
  For a repository you do not trust, also use `--check-isolation strict` (on
  `gitgoblin contribute` and `gitgoblin-engine run`), which hides your home
  directory from its commands, or run the engine in a container. Without an
  OS sandbox the install's network cannot be limited, and the run says so;
  `--no-sandbox` and `--check-isolation none` are for platforms without one.
- Run it on repositories you are allowed to contribute to. Discovery and
  analysis use public read-only data, but publishing a pull request is an
  action in someone else's project. See [docs/etiquette.md](docs/etiquette.md).
