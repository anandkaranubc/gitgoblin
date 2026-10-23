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

From code:

```ts
import { analyzeRepository, renderMarkdown } from "@gitgoblin/intel";

const report = await analyzeRepository("owner/name", { maxOpportunities: 10 });
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

## Working on it

```sh
npm test -w @gitgoblin/intel          # unit tests, offline
npm run typecheck -w @gitgoblin/intel
GITGOBLIN_E2E=1 npx vitest run test/e2e  # live runs against GitHub
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
