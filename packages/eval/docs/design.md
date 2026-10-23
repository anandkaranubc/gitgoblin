# gitgoblin eval: design

`@gitgoblin/eval` measures whether gitgoblin's discovery and contribution
intelligence are better than the conventional alternatives, using outcomes
that happened rather than opinions about what should happen. It is a
development tool: nothing in the product depends on it.

## Why outcomes

Every discovery tool we could find (GitHub Explore, firstissue.dev,
up-for-grabs, CodeTriage, Copilot Chat's "find repositories" workaround)
ranks by stars and by `good first issue` labels. The literature says labels
are a weak proxy: issue recommenders that work (RecGFI, GFI-Bot, PFIRec)
train on "resolved by a newcomer", not on the label, and a 2021-2025
longitudinal study of 37 popular projects found the merge rate of newcomer
pull requests on labelled issues fell from 62% to 42%. gitgoblin's own audits
(`packages/intel/docs/calibration-2026-10-22.md`) were judged by the person
who wrote the analyzers. Neither is the evidence a user needs.

The question a user actually has is "if I spend a weekend on this, will the
work be wanted and merged?" GitHub records the answer for everyone who tried
before. We use that.

## Principles

1. **Time travel, then measure.** Every prediction is computed from data
   available at a past date T; every outcome is measured in the window after
   T. Where an input cannot be reconstructed (stars at T, files at T) we use
   the current value and say so; the same leak applies to the baselines.
2. **Always a baseline.** A number without a baseline is a feeling. Each
   experiment reports stars, starter-issue count, push recency and random
   alongside gitgoblin, on the same candidates, with paired bootstrap
   confidence intervals.
3. **Use the product's own code.** Discovery's `scoreRepo` and intel's
   `analyzeRepository` are called as they are, fed with as-of-T inputs. No
   re-implementation of scoring in the harness.
4. **Deterministic and offline-testable.** Pure modules (labels, metrics,
   as-of reconstruction, baselines) are unit-tested with fixtures. Network
   fetches are cached as JSON under `.cache/` and the derived per-repository
   tables are committed under `data/` with the fetch date, so results can be
   re-derived without the network.
5. **No model calls, no new dependencies.** Model-based variants are a
   future comparison, not a prerequisite.

## Experiments

### E1. Discovery ranking against newcomer outcomes (`contribute` goal)

Pool: for each language, five star bands (10 to 49, 50 to 199, 200 to 999,
1,000 to 4,999, 5,000 and up) of repositories created more than 90 days
before T and pushed at some point after T minus 180 days, deduplicated and
capped per language with a fixed seed. The open-ended push qualifier is
implied by discovery's own 180-day rule for any repository eligible at T, so
it adds no survivorship bias; a closed range `pushed:A..B` would select
repositories whose last push fell in the range, which is exactly the set that
went quiet after T (see the results note). Label-based slices are not used
because label counts cannot be pinned to T; starter issues open at T come
from the issue history instead.

Inputs as of T, from GitHub GraphQL history: pull requests (created,
merged, closed, author, association, first responses), issues (created,
closed, labels, closed-by pull requests), default-branch commit count and
last commit before T, releases before T. Current values, flagged as such:
stars, forks, topics, community files, committer statistics from ecosyste.ms.
These are assembled into discovery's `EnrichedRepo` and scored with
`scoreRepo(repo, "contribute", { now: T })`; discovery's own exclusions
(archived, issues disabled, no push in 180 days) apply at T.

Outcome in [T, T + window]: pull requests by newcomers, where a newcomer is a
non-bot author who is not an owner, member or collaborator and whose first
pull request in the fetched history falls inside the window. From them:
merged count, merge rate over decided pull requests, median hours to the
first response from someone other than the author. Graded label:

| grade | meaning |
|---|---|
| 0 | no newcomer pull request merged |
| 1 | at least one merged |
| 2 | at least two merged and merge rate >= 0.5 |
| 3 | grade 2 and median first response within 7 days |

Rankings compared: gitgoblin, stars, starter issues open at T, days since
last commit at T, newcomer merge rate in the year before T (the behavioural
signal discovery does not have today), random. Metrics: nDCG@10, precision@10
of grade >= 2, Spearman correlation with merged count, AUC for grade >= 1,
each with a paired bootstrap over repositories and a per-language breakdown.

Learning: a logistic fit of the grade on discovery's signals with leave-one-
language-out validation says whether re-weighting would generalise. A change
to `profiles.ts` needs a held-out improvement, not a fitted one.

### E2. Intel opportunities against later changes

For the calibration and held-out repositories, analyze the default-branch
commit as of T (`RepoRef.ref` with `now` = T, links and dependency checks
off). Keep findings whose evidence is a file and line with an excerpt; drop
kinds that read the live API (issue, feature request, stale PR, triage, CI
health). At HEAD today, grade each: unchanged; file removed; excerpt gone.
For "excerpt gone", `git log -S` finds the first commit after T that removed
it, and the commit's pull request (if any) says whether an outsider or a
maintainer did it. Per analyzer kind: acted-upon rate and outsider rate; per
rank: acted-upon rate in the top five against the rest. A sample of
"excerpt gone" items is read by hand to estimate how often the change was a
fix rather than a refactor, and that estimate is reported with the rate.

Baseline: the resolution rate, in the same window, of issues that carried a
starter label at T in the same repositories, by outsiders. This answers
whether the work gitgoblin finds outside the tracker is more or less likely
to get done than the work inside it.

### E3. Beyond the tracker

From the E1 pull-request data: among merged pull requests by outsiders in
the year before T, the share that reference an issue; among issues closed as
completed, the share closed by an outsider's pull request. Both by language
and by project size. These are facts about the ecosystem that the product
thesis rests on, and the second is an upper bound on how much of the
tracker is contributable work.

### E4. Issue classifier (owned by intel)

`packages/intel/scripts/backtest-issues.ts` grades the lexical classifier
against maintainers' close reasons. The harness reuses it rather than
re-deriving it; a stronger label ("closed by a merged outsider pull request")
is available from the E3 data when intel exports `assessIssue`.

## Layout

```
src/metrics.ts      nDCG, precision@k, Spearman, AUC, paired bootstrap
src/outcomes.ts     newcomer labels and tracker statistics from PR and issue rows
src/asof.ts         EnrichedRepo as of T from history rows
src/baselines.ts    the conventional rankings
src/github/         GraphQL history fetchers (cached)
src/pool.ts         candidate pools pinned to T
src/discovery-backtest.ts, src/intel-backtest.ts   orchestration
src/report.ts       markdown tables
src/cli.ts          `node packages/eval/src/cli.ts <experiment> ...`
data/               committed derived tables, named by experiment and date
.cache/             raw responses, not committed
```

## Known limits

- Stars, forks, community files and committer statistics are current, not
  as of T. Stars favour the popularity baseline if anything.
- Author association is the current one; a newcomer who became a
  collaborator since T is counted as a maintainer and dropped.
- Repositories with more pull requests than the fetch cap in the two years
  around T have partial newcomer detection and are flagged.
- "Excerpt gone" is not "fixed"; the hand-read sample calibrates it.
- One snapshot date is one sample of history; the harness takes `--as-of`
  so the experiment can be repeated at other dates.
