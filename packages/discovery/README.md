# @gitgoblin/discovery

Finds repositories worth your time for a specific goal and explains why. This is
the engine behind `gitgoblin discover` and `gitgoblin explain`.

```ts
import { createDiscovery } from "@gitgoblin/discovery";

const { engine, sources } = await createDiscovery();
const results = await engine.discover({ goal: "contribute", filters: { languages: ["rust"] }, limit: 10 });
for (const r of results) console.log(r.repo.url, r.score, r.reasons.map((x) => x.detail));
sources.close();
```

`DiscoveryEngine` implements `Discoverer` from `@gitgoblin/core`. Construct it
directly with any objects satisfying `GitHubSource` and `EcosystemsSource` to
test without a network.

## Why not stars?

Stars measure attention, not fit. A 40k-star framework is a bad answer to "where
can I land my first pull request this week", and a 300-star library that
2,000 projects depend on but nobody has pushed to in two years is a great
answer to "what could I revive". So the engine computes several independent
signals and weighs them differently per goal.

This is measured, not assumed. `packages/eval` replays discovery on a past
date and checks where newcomers then got pull requests merged. On about 300
repositories in four languages, the contribute ranking beat stars,
starter-issue counts and recency at finding projects where newcomers landed
work. It said little about a newcomer's odds of being merged, though: the
share of pull requests a project merges predicted those best, and stars
predicted the opposite. That share is the `acceptance` signal. It is shown in
explanations but not yet weighted, because a re-weighting that uses it has
not yet passed its test on held-out dates (`packages/eval/docs/design.md`).

## Pipeline

1. **Search.** Several GitHub searches per goal, each a deliberately different slice (for `contribute`: repositories with starter issues, with help-wanted issues, and small active ones). Languages multiply the plans; topics, keywords, star bounds and dates narrow them. `seed` ("more like this") replaces the goal slices with the seed's topics, else its package keywords, else description words.
2. **Prefilter.** Archived repositories (except for `revive`, where forking one is a way to revive it), forks, excluded owners and anything outside the user's bounds are dropped before any enrichment.
3. **Rank cheaply.** Facts-only signals pick the top 3× limit candidates, at most `maxEnriched` (48). That is also the most results one search returns; a larger `limit` is lowered to it with a warning.
4. **Enrich.** ecosyste.ms repository data for everyone; package and issue statistics only for goals that weigh them; one batched GitHub GraphQL call when a token is available.
5. **Rank fully.** Weighted signals plus explained bonuses. Repositories the goal profile excludes (for example "no pushes in 6 months" for `contribute`) are removed.
6. **Diversify.** At most two results per owner near the top; the rest move down rather than disappearing.

A cold run makes 2 to 3 searches plus roughly 1 to 3 cached lookups per candidate.
Repeat runs within the cache TTLs are instant.

## Signals

All signals are 0..1; unknown stays `undefined` and is never treated as zero.

| Signal | Computed from | Sources |
| --- | --- | --- |
| activity | Half-life decay of days since last commit or push (45 days), blended with merged pull requests in the past year | GitHub, GraphQL, issues.ecosyste.ms |
| responsiveness | Decay of average issue (14 d) and pull request (10 d) close time over the past year, blended with merge ratio; falls back to recency of the last merged pull request | issues.ecosyste.ms, GraphQL |
| acceptance | Share of pull requests merged in the past year (at least 5), else all time (at least 10). All authors, maintainers included; `analyze` reports outsiders' share from a recent sample, so the two can differ | issues.ecosyste.ms |
| busFactor | Development distribution score (1 − top committer's share) and log-scaled committer count | repos.ecosyste.ms, GraphQL |
| newcomerFriendliness | CONTRIBUTING, code of conduct, issue templates, open starter issues, distinct pull request authors; zero when issues are disabled | GraphQL, repos.ecosyste.ms |
| docs | README, substantive description, homepage, changelog | repos.ecosyste.ms, GitHub |
| maturity | Age (saturating at 3 years) and log-scaled releases or tags | GitHub, GraphQL, repos.ecosyste.ms |
| popularity | log10 of stars, saturating at 50k | GitHub |
| usage | Dependent repositories, dependent packages and monthly downloads of the most-used package; forks as a weak fallback | packages.ecosyste.ms, GitHub |
| momentum | log-scaled stars per month since creation | GitHub |
| license | 1 permissive, 0.75 copyleft, 0.4 custom, 0 none | GitHub, GraphQL, repos.ecosyste.ms |

`Evidence` on every result carries the underlying numbers.

## Goals

Weights are in `GOAL_PROFILES` (`src/profiles.ts`). A negative weight rewards a
low signal.

| Goal | Weighs most | Excludes | Bonus |
| --- | --- | --- | --- |
| contribute | newcomerFriendliness, responsiveness, activity | archived, issues disabled, no push in 6 months | open starter issues |
| learn | docs, maturity, popularity | archived | |
| adopt | usage, then activity, responsiveness, maturity, busFactor, license | archived, no push in 18 months, no license | |
| revive | usage, **low** activity, license | pushed within a year (unless archived), no license | open-issue demand, fork ratio |
| explore | **low** popularity, activity, docs | archived | seeded random nudge (±0.08) |

Score = weighted mean of known signals × (0.75 + 0.25 × share of weight that
was known) + bonuses, clamped to 0..1. Scores compare within a goal only.

## Extending

- **New signal:** add it to `SIGNAL_NAMES` in core, compute it in `signals.ts`, describe it in `score.ts`, weigh it in a profile.
- **New goal:** add it to `GOALS` in core, a profile in `profiles.ts`, search variants in `queries.ts`.
- **New source:** implement `GitHubSource` or `EcosystemsSource`, or add a client in `@gitgoblin/sources` and thread it through `EnrichedRepo`.
- **New candidate strategy** (awesome lists, dependents of a seed, contributor graphs): add variants in `queries.ts` or another source in `engine.ts#search`.

## Limitations

- GitHub only for candidate search. ecosyste.ms enrichment already works for any forge, so adding GitLab or Codeberg search is a client, not a redesign.
- Keyword similarity for seeds without topics is fuzzy.
- Weights are hand-set from backtests, not learned from what users click. Change them only with a backtest on a date the change was not designed on (`packages/eval/docs/design.md` says how).
