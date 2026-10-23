# Architecture

gitgoblin is a set of small TypeScript packages that hand each other plain data. This page explains what each one does, how data flows between them, and the ideas they all share. It describes the design; the [README](../README.md#what-works-today) says what works today.

## The flow

```
 what you want               a repository              what to do              a pull request
 ──────────────  discover   ─────────────  understand  ─────────────  contribute  ──────────────
 goal + filters ──────────► RepoRef      ───────────►  Opportunity  ──────────► prepared change
                                                                                       │
                                                                                       ▼
                                                                          you approve, then publish
```

1. **Discover.** Given a goal and filters, rank public repositories and explain each ranking.
2. **Understand.** Given one repository, build a profile: nature, ecosystem, build and test commands, activity, how it treats outsiders, conventions.
3. **Find the work.** From the profile and the repository's issues, CI, docs, and code, produce a ranked list of concrete opportunities, each with evidence.
4. **Contribute.** Take one opportunity through investigate, plan, implement, verify, review, and prepare. Stop and hand over to a human the moment approval is needed.

## Packages

| Package | Owns | Key types |
| --- | --- | --- |
| `@gitgoblin/core` | Repository identity, discovery goals and signals | `RepoRef`, `parseRepoRef`, `Goal`, `DiscoveryQuery`, `DiscoveryResult`, `Discoverer` |
| `@gitgoblin/sources` | Talking to GitHub (REST and GraphQL) and the [ecosyste.ms](https://ecosyste.ms) open APIs, with a local SQLite cache and token discovery | HTTP clients |
| `@gitgoblin/discovery` | Ranking repositories for a goal: candidate strategies, signals, scoring with human-readable reasons | `Discoverer` implementation |
| `gitgoblin` (`packages/cli`) | The command line: `discover`, `explain`, `goals`, `cache`, `analyze`, `contribute`, `runs`, `show`, `publish` | |
| `@gitgoblin/intel` | Profiling a repository and finding opportunities | `RepositoryProfile`, `ContributionOpportunity`, `AnalysisReport` |
| `@gitgoblin/engine` | Turning one opportunity into a reviewable pull request | `Task`, `runContribution`, `publishRun` |
| `@gitgoblin/mcp` | gitgoblin as an MCP server: discovery and intel for any AI coding agent | `createServer`, the tools `discover_repositories`, `explain_repository`, `analyze_repository`, `get_opportunity` |

Each package is independently testable and has its own `package.json`, `tsconfig.json`, tests, and README. Root scripts (`npm test`, `npm run typecheck`) fan out to every package. Only two packages are published to npm, `gitgoblin` and `@gitgoblin/mcp`, and each bundles the packages it uses when it is packed ([docs/releasing.md](releasing.md)). The packages with non-trivial internal design each have a design note: [intel](../packages/intel/docs/design.md), [engine](../packages/engine/docs/design.md) and [mcp](../packages/mcp/docs/design.md).

## The contracts between them

Packages share data shapes, not internals. `core` is plain TypeScript types with no dependencies. `intel` and `engine` declare [Zod](https://zod.dev) schemas for the shapes they consume and validate at their boundaries, where JSON arrives from a file, a model, or another process. Where a package needs only a slice of another's type, it declares that slice itself; the engine's intake projections are the example.

- **`RepoRef`** (`core`) identifies a repository: `host`, `owner`, `name`. `host` is a hostname such as `github.com` or `codeberg.org`, not an enum, so identity works for self-hosted forges without code changes. Discovery and publishing go through GitHub's API, so they are GitHub-only today; intel also reads GitLab and Gitea or Forgejo through their public APIs, and gives any other host a clone-only analysis. `repoId` gives a stable lowercase key.
- **`DiscoveryResult`** (`core`) is one ranked repository: its facts, a score that is only comparable within the same goal, the normalized signals behind the score, the raw evidence behind the signals, and a list of reasons. A missing signal means unknown, never zero.
- **`AnalysisReport`** (`intel`) is what understanding a repository produces: a `RepositoryProfile`, a ranked list of `ContributionOpportunity`, the findings that were dropped and why, and the budget spent. Every opportunity carries at least one piece of `Evidence` a human can check, and every score decomposes into named factors with reasons.
- **`Task`** (`engine`) is the few fields the engine needs from a profile and an opportunity. The engine projects intel's types loosely, declaring only what it reads and passing the rest through, so intel can grow its schemas without breaking the engine. Text that came from a third party (issue bodies, commit subjects) is sanitized on the way in.

The contracts live in code, with doc comments:

- `packages/core/src/repo.ts` and `packages/core/src/discovery.ts`
- `packages/intel/src/contracts.ts`
- `packages/engine/src/types.ts` and `packages/engine/src/intake.ts`

## Ideas every package shares

- **Explain everything.** A score without reasons is a bug. Discovery results carry reasons, opportunities carry evidence, engine runs write every artifact to disk so a person can audit what happened.
- **Unknown is not zero.** Missing data stays missing. A repository with no release history is not punished as if it had a bad one.
- **Prefer the project's own judgment.** Build and test commands, conventions, and contribution rules are read from the repository, quoted into prompts, and followed. gitgoblin does not impose its own style on other people's code.
- **Humans approve external writes.** Discovery and analysis read public data. The engine sends the repository's code and issue text to the model provider you configure, from your machine. Anything that changes the outside world waits for a person. This is enforced in code, not in prompts; see [SECURITY.md](../SECURITY.md).
- **Test without the network or a model.** Each package separates pure logic from I/O so the logic can be tested with fixtures. The engine is designed around an `AgentRunner` interface so its orchestration and policy can be tested with scripted runners.

## The contribution engine, briefly

The engine is designed to run one opportunity through a pipeline: intake, workspace, baseline, orient, plan, implement, verify, review, prepare, and then, only after approval, publish. Orient, plan, and implement share one agent session so the implementer keeps the reasons behind its decisions. Review runs in a fresh session that never sees the implementer's transcript, because independence is the point. Verification compares the project's own checks against a baseline taken before any change, so pre-existing failures are never blamed on the contribution. A pure policy module decides whether to continue, retry, escalate to a human, or stop.

The full design, including security boundaries and the prior art it borrows from, is in [packages/engine/docs/design.md](../packages/engine/docs/design.md).

## Glossary

- **Goal:** what the user is trying to do. One of contribute, learn, adopt, revive, explore. The same repository ranks differently under different goals.
- **Signal:** a normalized quality of a repository in the range 0 to 1, such as activity or newcomer friendliness.
- **Evidence:** the raw, checkable fact behind a signal, score, or opportunity.
- **Profile:** intel's structured description of one repository.
- **Opportunity:** one concrete, evidence-backed piece of work worth doing in a repository.
- **Welcomeness:** how a project treats outside contributors, from closed to eager, with the signals that led to that judgment.
- **Run:** one pass of the engine over one opportunity, with its artifacts stored under a run id.
- **Baseline:** the result of the project's own checks before any change was made.
- **Escalate:** stop and ask a human, with the questions written down.

## Tooling

- Node.js 24, which runs TypeScript directly, so development needs no build step.
- npm workspaces for the monorepo.
- [Vitest](https://vitest.dev) for tests, [Zod](https://zod.dev) for runtime validation at boundaries.
- The engine drives its agent sessions through the Claude Agent SDK, with a sandbox and tool allowlists as the hard boundary.
