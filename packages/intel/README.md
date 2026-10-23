# @gitgoblin/intel

Repository understanding and contribution-opportunity discovery for gitgoblin.
Give it a public repository; it tells you what the project is, how to work on
it, whether outsiders' work actually gets merged, and what is worth doing,
with evidence for every claim.

```sh
npm install                      # from the repository root; no build step
node packages/intel/src/cli.ts analyze jd/tenacity            # Markdown report
node packages/intel/src/cli.ts analyze jd/tenacity --json     # AnalysisReport
```

A GitHub token (`gh auth login`, or `GITHUB_TOKEN`) unlocks issue and pull
request analysis. Without one, metadata and code analysis still run.

`--llm` adds a second opinion from Claude on issue triage: it can bring back
defects the lexical pass found too vague and demote questions it let through.
Every model judgement is attached as evidence with a verbatim quote, and the
model never invents findings. It is off by default because it costs money; it
needs `ANTHROPIC_API_KEY` or `ant auth login` (default model `claude-opus-5-5`,
override with `--llm-model <id>` or `GITGOBLIN_MODEL`).

From code:

```ts
import { analyzeRepository, renderMarkdown } from "@gitgoblin/intel";

const report = await analyzeRepository("owner/name", { maxOpportunities: 10 });
// or at a commit: analyzeRepository({ owner, name, ref: "v2.1.0" }, ...)
console.log(renderMarkdown(report));
```

## What comes out

An `AnalysisReport` (schemas in `src/contracts.ts`):

- `profile`: nature (library, CLI, awesome list, ...), ecosystems with the
  commands to install, test and lint, activity, welcomeness level with the
  signals behind it, contribution rules, conventions, hot files.
- `opportunities`: ranked, each with `evidence[]`, five scored factors with
  reasons, effort, files to read, approach, acceptance criteria, etiquette and
  risks.
- `skipped`: what was filtered and why, so the ranking can be audited.
- `budget`: time, API calls, HTTP checks, and whether anything was cut short.

## How it works

`docs/design.md` has the full design. In short: clone with `--filter=blob:none`,
inventory files, read manifests, sample issues and PRs over GraphQL, build the
profile, run the analyzers in `src/analyzers/`, then filter, cluster and score
in `src/evaluate/`. Scores are a weighted geometric mean, so an item nobody
will merge, or that someone is already doing, sinks even if it looks great.

Everything read is treated as untrusted: symlinks in the checkout are never
followed, the link checker only contacts public hosts on standard ports, model
input and output are sanitised, and every repository- or issue-authored string
in the report is flattened to one line. `--local` is the exception: it analyzes
a checkout as it is and trusts that checkout's git configuration. Commands in
the profile are copied from the repository's own files; show or sandbox them,
never run them on trust. `docs/design.md` lists the boundaries.

## How well does it work?

`docs/calibration-2026-10-22.md` records a full-list audit: 133 opportunities
across thirteen GitHub repositories, 101 clear positives, 23 debatable, 8 false
positives (since fixed). GitLab and Gitea/Forgejo hosts (Codeberg among them) get
issues, merge requests and labels through their public APIs with maintainers
inferred from who merges; other hosts work from the clone alone. The report
says which applied.

An independent check grades the issue classifier against maintainers' own
close reasons: across 1,782 recently closed issues in twelve trackers, 89% of
what it would have accepted was later closed as completed (93% excluding
duplicates), against an 80% base rate, at 49% recall by design
(`node scripts/backtest-issues.ts owner/name ...`). For code findings,
`scripts/backtest-code.ts` analyzes a year-old commit and checks today's HEAD:
across 49 repositories in two sets, CI-rot findings were fixed at 43% to 89%
against 6% to 13% churn for random lines in the same files; broken links at 50%
to 63%; TODOs and deprecations at two to four times churn, with deprecations
the least consistent kind.

## Working on it

```sh
npm test -w @gitgoblin/intel          # unit tests, offline
npm run typecheck -w @gitgoblin/intel
GITGOBLIN_E2E=1 npx vitest run test/e2e  # live runs against GitHub, incl. test/e2e/expectations.json
node scripts/summarize-reports.mjs /path/to/reports/  # one table from many --json reports
```

- Add an analyzer: implement `Analyzer` from `src/analyzers/types.ts`, return
  `Finding`s with evidence and signals, register it in `src/analyzers/index.ts`.
- Add a CI or deprecation rule: edit the tables in `src/analyzers/ci-rules.ts`
  or `src/analyzers/deprecation-rules.ts`; every rule needs a date and a
  reference a contributor can cite.
- Fixtures in `fixtures/` are real reports and are validated against the
  schema in tests. Regenerate with
  `node src/cli.ts analyze jd/tenacity --json --max 5 --no-links --out fixtures/tenacity.report.json`.

Caches live under `$XDG_CACHE_HOME/gitgoblin/intel` (override with
`GITGOBLIN_CACHE_DIR`).
