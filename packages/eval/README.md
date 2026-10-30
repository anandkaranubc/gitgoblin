# @gitgoblin/eval

Measures whether gitgoblin's discovery and contribution intelligence beat the
conventional alternatives, using what actually happened on GitHub rather than
anyone's opinion. A development tool: nothing in the product depends on it.

`docs/design.md` explains the experiments and their limits;
`docs/research-2026-10-23.md` is the landscape and literature review behind
them; `docs/results-*.md` are the measured results.

```sh
# Discovery: does the contribute ranking, computed from what was knowable on
# a past date, predict where newcomers got pull requests merged afterwards?
node packages/eval/src/cli.ts discovery fetch --as-of 2026-06-20 --window 120 \
  --languages typescript,python,rust,go --per-language 120 --out packages/eval/data/discovery-backtest-2026-06-20.json
node packages/eval/src/cli.ts discovery evaluate packages/eval/data/discovery-backtest-2026-06-20.json
node packages/eval/src/cli.ts discovery learn packages/eval/data/discovery-backtest-2026-06-20.json
node packages/eval/src/cli.ts discovery slices packages/eval/data/discovery-backtest-2026-06-20.json

# Intel: were the opportunities found at a past commit acted upon since, and by whom?
node packages/eval/src/cli.ts intel fetch --as-of 2026-04-25 --repos expressjs/express,psf/requests --out packages/eval/data/intel-backtest-2026-04-25.json
node packages/eval/src/cli.ts intel report packages/eval/data/intel-backtest-2026-04-25.json

# Intel, issue side: what happened to the issue-backed opportunities it accepted? Re-run this
# months later against the same file; it records when each analysis ran.
node packages/eval/src/cli.ts intel issues packages/eval/data/intel-backtest-2026-04-25.json --out packages/eval/data/intel-issues-2026-04-25.json
node packages/eval/src/cli.ts intel issues-report packages/eval/data/intel-issues-2026-04-25.json

# Issues: of the issues open on a past date, which did outsiders fix, and does intel's classifier pick them better than labels do?
node packages/eval/src/cli.ts issues fetch --from packages/eval/data/discovery-backtest-2026-06-20.json --repos 100 --out packages/eval/data/issue-outcomes-2026-06-20.json
node packages/eval/src/cli.ts issues report packages/eval/data/issue-outcomes-2026-06-20.json

# Beyond the tracker: of the pull requests outsiders got merged, how many had an issue, and what were they?
node packages/eval/src/cli.ts tracker packages/eval/data/discovery-backtest-2026-06-20.json
node packages/eval/src/cli.ts tracker kinds packages/eval/data/discovery-backtest-2026-06-20.json --out packages/eval/data/tracker-kinds-2026-06-20.json
```

## Changing discovery's ranking

The datasets keep discovery's input as it was on each date, so a change to
`packages/discovery` can be measured on the same past without fetching again:

```sh
node packages/eval/src/cli.ts discovery compare packages/eval/data/discovery-backtest-2026-02-15.json
node packages/eval/src/cli.ts discovery evaluate packages/eval/data/discovery-backtest-2025-10-15.json --rescore
```

`compare` scores every repository with the code checked out now and reports
the paired change in both outcomes: graded newcomer success (nDCG@10) and a
newcomer's odds (correlation with the share of their pull requests merged).
Design a change on one date and test it on the others; `docs/design.md`
records the rule used so far, and why the last candidate was retired.

`fetch` needs a GitHub token (`gh auth login` or `GITHUB_TOKEN`) and caches
every response under `packages/eval/.cache/`, so a snapshot can be re-derived
without the network. `evaluate`, `learn`, `tracker` and `report` are offline
and run on the committed files under `data/`.

```sh
npm test -w @gitgoblin/eval        # unit tests, offline
npm run typecheck -w @gitgoblin/eval
```
