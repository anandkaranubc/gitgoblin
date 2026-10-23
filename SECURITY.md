# Security

gitgoblin reads other people's repositories, runs an AI agent against them,
and prepares pull requests. That makes a few things security-sensitive that
would not be in an ordinary CLI. This page explains how to report a problem and
what we consider one.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. If that option is not
available, contact the maintainer, [@anandkaranubc](https://github.com/anandkaranubc),
privately at the email address on that GitHub profile.

Include what you found, how to reproduce it, and what an attacker could do
with it. A proof of concept helps; a working exploit against a real
third-party repository does not, so please demonstrate against a repository
you control.

gitgoblin is maintained by volunteers. We aim to acknowledge reports within
seven days and to tell you what we plan to do within thirty. We will credit
you in the fix unless you prefer otherwise.

## Supported versions

gitgoblin has not published a release yet. Only the `main` branch receives
fixes. Once releases exist, this section will say which ones are supported.

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
- Run it on repositories you are allowed to contribute to. Discovery and
  analysis use public read-only data, but publishing a pull request is an
  action in someone else's project. See [docs/etiquette.md](docs/etiquette.md).
