# Excluded projects

Maintainers who do not want gitgoblin-assisted contributions can ask to be listed here; [etiquette.md](etiquette.md) explains the commitments behind this. Being listed means gitgoblin users must not open pull requests, issues, or comments in the project, and gitgoblin's tools refuse to: discovery leaves listed projects out, and `analyze`, `contribute`, `publish` and the MCP server's tools refuse them.

To be added or removed, fill in the [maintainer form](https://github.com/anandkaranubc/gitgoblin/issues/new?template=maintainer_report.yml). No reason is needed.

Entries are one per line under List as `host/owner/name`, for example `github.com/example/widgets`, and case does not matter. An entry without a name, such as `github.com/example`, excludes everything that owner has.

This file is the list the tools read. Each release carries a copy, and every install also reads this file from `main` at most six hours old, so an entry applies without waiting for a release. A test keeps the copy in `packages/core/src/excluded.ts` equal to this file, so adding an entry means adding it there too.

## List

No projects have asked to be excluded yet.
