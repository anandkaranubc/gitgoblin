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

Decision rule, written down on 2026-10-23 before the first complete E1
dataset was read: a change to discovery's `contribute` ranking ships only if
(a) on the primary metric, macro nDCG@10 over languages, it beats the current
score with a paired 95% bootstrap interval that excludes zero; (b) it does so
on a second as-of date not used to design it; and (c) the signal it adds can
be computed at query time from data discovery already fetches or can fetch
for about one request per candidate. Secondary metrics (AUC, precision@10)
are reported but cannot carry a decision on their own.

Amendment, 2026-10-23 17:43 UTC, written after reading the 2026-06-20 data and before
reading any 2026-02-15 data. The 2026-06-20 data showed that the graded
outcome partly rewards busy projects, and that a second outcome matters to a
newcomer: the share of newcomers' pull requests that get merged ("newcomer
odds", Spearman with the ranking among repositories with three or more decided
newcomer pull requests). It was not pre-registered, so it is treated as a
hypothesis from the design date and tested on the held-out date. One candidate
was chosen on 2026-06-20 ("V2": a new `acceptance` signal, the share of pull
requests merged in the past year, weight 3; responsiveness 3 to 1; activity
2.5 to 3; bus factor 1 to 2; newcomer friendliness 3 to 2; docs 1.5 to 0.5;
license 1 to 0.5). It ships if, on 2026-02-15, against the current weights:
(1) the newcomer-odds correlation improves with a paired 95% interval that
excludes zero, and (2) nDCG@10 does not get worse by more than 0.05 (the
lower bound of its paired interval is above -0.05). No other candidate is
tested on 2026-02-15.

Outcome, 2026-10-23 18:58 UTC. On 2026-02-15 (334 covered repositories, 80 with three or
more decided newcomer pull requests), against the current weights: newcomer
odds +0.105 [+0.017, +0.194], criterion 1 met; nDCG@10 +0.048 [-0.069,
+0.145], criterion 2 not met (lower bound below -0.05). V2's weights do not
ship. The `acceptance` signal ships as information only (weight 0 in every
goal, so no score changes) because it is the measure a newcomer needs and the
one that predicted their odds on both dates.

Second confirmatory test, written before any data for its date is fetched:
V2 unchanged, as of 2025-10-15, 120-day window, the same pool design with
seed 3. V2's weights ship if both criteria above are met on that date. Its
pool overlaps the other two dates' pools in part; the windows do not overlap.
Whatever the result, it is reported in the results note.

Outcome, 2026-10-23 20:08 UTC. On 2025-10-15 (329 covered repositories, 73 with three or
more decided newcomer pull requests): newcomer odds +0.015 [-0.092, +0.112]
and nDCG@10 -0.012 [-0.084, +0.082]. Neither criterion is met. V2's weights
do not ship and the candidate is retired; the next attempt starts from a new
design date.

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

### E5. Which open issues do outsiders resolve?

Close reasons say whether a maintainer considered an issue done, not whether
an outsider could do it. This experiment takes the issues open at a past date
T in 100 repositories sampled (seed 1) from E1's eligible pool, assesses each
with intel's own classifier as the issue looked at T (`issueAsOf` and
`assessIssue` from `@gitgoblin/intel/backtest`: comments after T and pull
requests merged or touched after T removed, clock at T), and records what
happened in the 120 days after: closed as completed by a merged pull request
from an outsider (not an owner, member, collaborator or bot), by a
maintainer's pull request, completed some other way, closed as not planned,
or still open.

The same issues are grouped by what would have pointed someone at them:
intel accepts it (as an issue or feature request), intel calls it triage, it
carries a starter label, a maintainer commented before T, it was opened in
the 90 days before T, or nothing at all (every issue open at T). Each group's
share resolved by an outsider gets a 95% interval from resampling
repositories, since issues in one repository are not independent. Open
issues are read newest-updated first and capped at 200 per repository, so
the stalest issues of the busiest repositories are missing; the report says
where. "Accepted" is the classifier's verdict, before intel's ranking and its
cap of fifteen opportunities per report.

Confirmatory test, 2026-10-24 04:27 UTC, written after reading the 2026-06-20 run and
before any data for its date is fetched. On 2026-06-20 an exploratory split
suggested that intel's verdict and an issue's age work together: accepted
issues opened in the 90 days before T were resolved by outsiders at 12.6%,
older accepted issues at 3.4%. The test repeats E5 on 2026-02-15 (100
repositories from that date's pool, seed 1, the same code) and passes if the
difference between those two groups' outsider-fix rates has a 95% interval,
resampling repositories, above zero. Whatever the result, it is reported.

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
