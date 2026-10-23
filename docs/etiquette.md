# How gitgoblin behaves in other people's projects

gitgoblin explores public repositories and helps people contribute to them. The maintainers of those repositories never asked for this, and their time is the scarcest resource in open source. This page is the set of commitments gitgoblin makes to them and what it asks of anyone who uses it.

It is written for three readers: maintainers who have received a gitgoblin-assisted contribution, people using gitgoblin, and people building it.

> **Where this stands (October 2026).** gitgoblin is in preview. The contribution engine enforces the first commitment in code: it publishes nothing until a person confirms at a terminal, and it runs the model in a sandbox without network access. It reads a project's contributing guide and templates and quotes them to the model, and it skips an issue someone is already working on (an assignee, an open pull request, or a comment claiming it). Two things are not built yet: detecting a project's policy on AI-generated contributions ([#79](https://github.com/anandkaranubc/gitgoblin/issues/79)), and refusing projects on the excluded list automatically ([#78](https://github.com/anandkaranubc/gitgoblin/issues/78)). Until they are, the person approving a contribution checks both by hand.

## Commitments

1. **A person is accountable for every contribution.** gitgoblin prepares work; a human reads it, approves it, and publishes it from their own account. That person answers review comments and stands behind the change. gitgoblin never opens pull requests, pushes commits, or posts comments on its own.

2. **The project's rules come first.** Before proposing work, gitgoblin reads the project's contributing guide, templates, code of conduct, and instruction files, and the change follows them: rules that ask for an issue before a pull request, a contributor license agreement (CLA) or Developer Certificate of Origin sign-off (DCO), commit conventions, and explicit statements about changes the maintainers do not want. Archived projects, read-only mirrors, and projects that say they do not accept outside contributions are left alone.

3. **Evidence before action.** Every opportunity gitgoblin proposes points at something checkable: a file and line, an issue, a failing workflow, a dead link. "This might be improved" is not a contribution.

4. **Small, finished, and tested.** One change per pull request, in the project's style, with tests where the project has tests, verified against the project's own checks. No batches of unrelated edits, no sweeps of the same cosmetic change across many repositories, no pull requests opened to see what sticks.

5. **Nobody's work is taken.** If an issue has an assignee, a linked pull request, or a recent comment from someone saying they are on it, it is skipped. When a project asks contributors to claim an issue first, that comment comes from the person, not the tool.

6. **AI assistance is disclosed.** Pull requests prepared with gitgoblin say so in their description. When a project has a policy on AI-generated contributions, it is followed, including policies that forbid them.

7. **Quiet projects are approached with care.** gitgoblin can surface valuable projects that have gone quiet. Surfacing is not the same as flooding a dormant inbox. A contribution to a quiet project should be easy to merge or easy to ignore, and never one of a stream.

## If you use gitgoblin

Before you approve anything for publishing:

- Read the whole diff. If you could not explain a line in review, do not publish it.
- Check the project's contributing guide yourself. gitgoblin quotes it; you are responsible for following it.
- Make sure you would open this pull request by hand.
- Expect to follow up. A pull request is the start of a conversation, not the end of a task.

## If you maintain a project

A contribution prepared with gitgoblin arrives from an ordinary GitHub account, under that person's name. The pull request description has a summary linking the issue, the list of changes, a table of your project's own checks with pass or fail results compared against the base commit, notes for reviewers including known gaps, your pull request checklist when you have a template, and a footer saying gitgoblin prepared it and a person approved it.

You can:

- **Review it like any other pull request**, including declining it. You owe it nothing extra.
- **Ask the author** how the change was made. They should be able to answer.
- **Opt your project out.** Fill in the [maintainer form](https://github.com/anandkaranubc/gitgoblin/issues/new?template=maintainer_report.yml) and we will add your project to the [excluded projects list](excluded-projects.md). You do not need to give a reason. People keep that list today; making discovery and the engine refuse excluded projects automatically is planned, and the file will stay the source of truth.
- **Report a bad experience.** If a gitgoblin-assisted contribution broke one of the commitments above, use the same form with a link. We treat that as a bug in gitgoblin, whether the fault was the tool's or the user's.

## If you build gitgoblin

These commitments are requirements. Where the code does not yet enforce one, that is a gap to close, not a reason to relax it. A change that makes it easier to break one (publishing without approval, skipping the contributing guide, ignoring the excluded list) is a bug, and the fix belongs in code, not in a prompt. See [SECURITY.md](../SECURITY.md) for the boundaries we consider security-relevant.
