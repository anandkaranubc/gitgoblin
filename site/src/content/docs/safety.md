---
title: Safety and etiquette
description: The boundaries enforced in code, what the agent can never do inside a run, and the commitments gitgoblin makes to the projects it touches.
order: 4
---

# Safety and etiquette

Maintainers did not ask for gitgoblin, and their time is the scarcest resource in open source. The safety story has two halves: what the software is physically unable to do, and what it promises to the people on the other end.

## What leaves your machine

Be precise about this, because "nothing leaves your machine" would be false. Discovery and analysis call GitHub and the ecosyste.ms APIs to read public data. The engine sends the target repository's code, issue text and your prompts to the model provider while it works, before anything is approved. What waits for a person is publishing: no push, pull request or comment happens until someone approves it, from their own account.

## Enforced in code

Inside a run, the agent is boxed in:

- Sessions run with the workspace as their working directory and with the target repository's own agent settings and hooks never loaded. Its `CONTRIBUTING.md`, `CLAUDE.md` and `AGENTS.md` are read by the engine and quoted into the prompt instead.
- Each phase gets an explicit tool allowlist and runs without interactive prompts.
- The Agent SDK sandbox limits writes to the workspace and temp directories and blocks the network. The engine refuses to run unsandboxed unless asked.
- Hooks deny, regardless of mode: `git push`, remote changes, `gh`, network tools, package publishing, installing packages, `sudo`, container and system tools, writes outside the workspace, writes into `.git/`, and writes to protected paths such as CI workflows, release config and secrets. Hooks are best-effort text matching; the sandbox is the hard boundary.
- The agent subprocess gets a scrubbed environment: path, home, locale and Anthropic auth only. `GH_TOKEN`, cloud credentials and similar never reach it.
- Publishing uses the operator's `gh` login from the engine process, never from an agent.

A change that makes it easier to break any of this is a bug, and the fix belongs in code, not in a prompt. [SECURITY.md](https://github.com/anandkaranubc/gitgoblin/blob/main/SECURITY.md) says how to report one.

## Promised to maintainers

The full policy is [docs/etiquette.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/etiquette.md). In short:

1. A person is accountable for every contribution and answers review comments.
2. The project's rules come first: issue-first policies, CLA or DCO, commit conventions, and explicit "we don't want this" statements. Archived projects and projects that refuse outside contributions are left alone.
3. Evidence before action. "This might be improved" is not a contribution.
4. Small, finished and tested. One change per pull request, in the project's style. No sweeps, no spam.
5. Nobody's work is taken. Assigned issues, linked pull requests and recent "I'm on it" comments are respected.
6. AI assistance is disclosed when it matters, and policies that forbid it are followed.
7. Quiet projects are approached with care, never flooded.

## Opting out

If you maintain a project and want gitgoblin to leave it alone, fill in the [maintainer form](https://github.com/anandkaranubc/gitgoblin/issues/new?template=maintainer_report.yml). No reason is needed. The list lives in [docs/excluded-projects.md](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/excluded-projects.md): listed projects must not receive pull requests, issues or comments from gitgoblin users, and its tools are expected to refuse to.

If a gitgoblin-assisted contribution broke one of the commitments above, open an issue with a link. That is treated as a bug in gitgoblin, whoever was at fault.

## Before you approve anything

- Read the whole diff. If you could not explain a line in review, do not publish it.
- Check the project's contributing guide yourself. gitgoblin quotes it; you are responsible for following it.
- Make sure you would open this pull request by hand. If it feels like noise, it is noise.
- Expect to follow up. A pull request is the start of a conversation, not the end of a task.
