# gitgoblin intel: design

`@gitgoblin/intel` answers two questions about any public repository:
*what is this project and how does it work*, and *what could an outsider
contribute that the maintainers would actually want*. It is the middle of
the gitgoblin pipeline: discovery picks repositories, intel understands them
and proposes opportunities, the engine executes.

## Principles

1. **Evidence or nothing.** Every opportunity carries evidence a person can
   check in under a minute: a file and line, an issue URL, an HTTP status,
   a commit. Findings without evidence are not emitted.
2. **Welcomeness is behaviour, not paperwork.** A `CONTRIBUTING.md` says
   little. Whether outsiders' PRs get merged, how fast maintainers respond,
   whether the repo is archived, and what the maintainers have said they do
   not want, say a lot. We measure those.
3. **Beyond the issue tracker.** Many valuable contributions have no issue:
   CI that is about to break, deprecated APIs, docs that drifted from the
   code, hot code with no tests, abandoned PRs with maintainer approval.
   Many issues are not opportunities: claimed, assigned, blocked, or stale.
4. **Refuse to be spam.** Typo fixes, formatting churn, unsolicited
   refactors, badge additions and dependency bumps where a bot already runs
   are filtered out and listed under `skipped` with the reason.
5. **Deterministic core, grounded synthesis.** Facts come from code, git and
   APIs. A language model, when added, only rewrites and prioritises with
   citations to evidence ids; it never invents findings.
6. **Explainable scores.** Scores decompose into named factors, each with a
   reason. The aggregate is a weighted geometric mean so a near-zero factor
   (nobody will merge it; someone is already doing it) sinks the item even
   when the rest look great.
7. **Budgeted.** Clone with `--filter=blob:none`, cap files examined, cap
   API calls, and say in `budget.truncated` when analysis was cut short.

## Pipeline

```
RepoRef ──> fetch metadata (REST) ──> partial clone ──> file inventory
        ──> profile: nature, ecosystems, activity, welcomeness, conventions
        ──> analyzers (each emits Findings with Evidence)
        ──> evaluate: filter, cluster, score, rank ──> AnalysisReport
```

Contracts live in `src/contracts.ts`. `RepoRef` mirrors `@gitgoblin/core`.
Output types are owned here and imported by the engine.

## Repository profile

| Field | How it is derived |
|---|---|
| `nature` | Manifests (bin entries, `private`, frameworks), name and topics (`awesome`, `dotfiles`, `tutorial`), file mix (mostly markdown, numbered dirs), `is_template`, `CITATION.cff`. Each rule gives a reason. |
| `ecosystems` | Manifest files present (`pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, ...), lockfiles, tool configs. Commands come from manifest scripts and CI steps, in that order. |
| `activity` | `git log` over 365 days (commits, authors, bus factor, hot files); GraphQL samples of recent issues and PRs (first-response medians, external merge rate). |
| `welcomeness` | Weighted signals with evidence, mapped to a level. Archived or "not accepting contributions" is `closed` regardless of other signals. |
| `conventions` | Commit subjects (conventional commits ratio), merged PR branch names and sizes, test and lint tooling. |

### Welcomeness signals

Negative: archived, read-only mirror, "not accepting", last push over a year
ago, open PRs with no maintainer response, external merge rate under 20%,
median first response over 30 days.
Positive: help-wanted and good-first-issue labels used in the last 180 days,
external merge rate over 50%, median first response under 3 days,
CONTRIBUTING with a working dev setup, PR template, recent merges from
first-time contributors.
Rules (not penalties, but etiquette): issue-first policy, CLA or DCO,
tests or changelog required, kinds of change the maintainers reject.

Levels: `closed` (0), `dormant` (< 0.25), `selective` (< 0.5),
`open` (< 0.8), `eager`. Two guards keep the levels honest: a project that
still commits or answers issues is floored at `selective` (dormant means
nobody is home), and one that merges under 20% of outside PRs is capped at
`selective` however fast it replies. Closed repositories skip the analyzers.

## Analyzers

Each analyzer is a function `(ctx, profile) => Finding[]`. Findings are
internal and richer than opportunities: they carry a cluster key and raw
signals used by the evaluator.

| Kind | What it checks | Verification | Confidence |
|---|---|---|---|
| `issue` | Open issues with repro, maintainer confirmation or help labels; detects in-flight work (assignee, linked PR, recent claim). | GraphQL timeline | high for labels/PR links, medium for text cues |
| `feature_request` | Enhancement issues a maintainer endorsed, nothing underway. | GraphQL comments by members | medium |
| `stale_pr` | Open PRs idle 60+ days with approval or "needs rebase", author inactive. | GraphQL reviews, mergeable state | high |
| `triage` | Unanswered issues older than 14 days in responsive repos. | GraphQL | high |
| `ci_rot` | Retired runners, shut-down action versions, removed workflow commands, Python versions not installable on the runner, unsafe `pull_request_target` checkouts. | Rule table with dates and references, matched line by line in workflow YAML | high |
| `deprecation` | Removed or deprecated stdlib modules and APIs per ecosystem, gated on the runtime range the project claims to support. | Regex over source, gated on manifest | high when gated, else medium |
| `dependency` | Known vulnerabilities (OSV batch API) and npm packages marked deprecated, from lockfiles and manifests. | External API | high |
| `docs_drift` | CLI flags, imports and package names in README that do not exist in code. | Cross-reference docs tokens against code symbols | medium |
| `broken_link` | Relative links to missing files, anchors to missing headings, HTTP 404 and 410 after retry. | File system, HTTP | high |
| `test_gap` | Source files changed often in the last year with no corresponding test; skipped or xfail tests with their stated reasons. | git log plus naming conventions and content grep | medium |
| `tech_debt` | TODO or FIXME that references a closed issue or a condition now met (dropped Python version), or is specific and old. | git blame, issue API | high for closed refs, low otherwise |
| `hygiene` | Missing LICENSE, no CI despite tests, typed Python package without `py.typed`. Only where the repo's nature warrants it. | File system | high |

Analyzers skip vendored, generated and minified paths, and skip entirely for
natures where they make no sense (no test gaps in an awesome list).

## Evaluation

Factors, each 0 to 1 with a reason:

- `value`: kind prior adjusted by specifics (issue reactions and duplicates,
  a CI break with a date, how many users a library has).
- `feasibility`: localised change, repro present, tests exist to extend,
  no design decision needed.
- `welcomeness`: repository level, adjusted per kind (dependency bumps near
  zero when a bot exists; help-wanted issues up; refactors down).
- `confidence`: verification strength from the table above.
- `novelty`: 0.05 with a linked open PR, 0.2 with an assignee or a claim in
  the last 45 days, 0.9 otherwise.

`score = value^0.35 * feasibility^0.15 * welcomeness^0.25 * confidence^0.15 * novelty^0.10`

Hard filters (reported in `skipped`): archived repo, cosmetic-only changes,
bot-covered dependency bumps, findings in vendored paths, novelty under 0.1,
cluster duplicates. Findings sharing a cluster key (for example, all uses of
one deprecated API) become one opportunity with combined evidence, capped at
twelve items plus a count.

## Budget and scale

- Clone: `git clone --filter=blob:none --single-branch`; `--depth 2000`
  added when the API reports a repository over 300 MB. `git log --name-only`
  never fetches blobs, so churn and authorship are cheap even on big repos.
- Files: at most 50k paths inventoried; analyzers read text files under
  512 KB. `git blame` in a blob-less clone fetches one blob per revision, so
  it only runs on files with at most 40 revisions, three lines per run.
- API: REST metadata (4 calls) and four GraphQL sample queries (open and
  closed issues, open and closed PRs). GitHub nulls out nodes and reports
  `RESOURCE_LIMITS_EXCEEDED` when a query is too heavy for a busy repository,
  so each query keeps whatever came back and halves its page size while more
  than half the nodes are null. Access goes through `@gitgoblin/sources` when
  present (shared cache and rate-limit budget), else a built-in client that
  stops when the remaining limit falls under 30.
- HTTP link checks: concurrency 8, 8 s timeout, one retry, off with
  `--no-links`.

Measured on 2026-10-22: 5 to 25 s per repository with a warm clone (express,
requests, fzf, ripgrep, tenacity); first clone adds 1 to 3 s for these sizes.

## Interfaces

- Input: `RepoRef` from discovery, optional `AnalysisHints`.
- Output: `AnalysisReport` consumed by the engine and the `gitgoblin` CLI.
- GitHub access goes through the `GitHubApi` interface (`rest`, `graphql`)
  so `@gitgoblin/sources` can be plugged in behind one adapter.

## Validation

- Unit tests build throwaway git repositories and mock HTTP, so the suite
  runs offline.
- `test/e2e` runs against real repositories when `GITGOBLIN_E2E=1`, with a
  diverse set: a Python library, a Node application, a Go CLI, a Rust
  crate, an archived repository, an awesome list, and one very large repo.
  Expectations are about facts (nature, welcomeness level, specific rules
  firing), not about exact scores.

## Not in v0

Language-model synthesis, non-GitHub forges (schema allows them; code does
not), flaky-test detection from CI history, coverage-based test gaps,
issue candidates passed in `hints` that are missing from the sample (they are
boosted when present, not fetched). Each has a slot in the pipeline above.

## Known limits

- Issue classification is lexical. Defects described without defect language
  are passed over as "unclear"; the report lists them under `budget.notes`.
- Test gaps rely on naming and mentions, not coverage; Rust and Go get lower
  confidence because their tests often live elsewhere.
- Welcomeness without a GitHub token uses git and metadata only and says so.
- Link checks skip hosts that block automated clients, so some dead links are
  never reported rather than reported wrongly.
