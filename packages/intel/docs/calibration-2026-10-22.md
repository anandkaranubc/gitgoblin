# Calibration audit, 2026-10-22

Every opportunity from a fresh sweep of thirteen GitHub repositories was read
against its evidence and judged the way a maintainer would. "Uncertain" means
the item is defensible but a maintainer might reasonably decline it (design
decisions, infrastructure-only tasks, very old threads).

| Repository | Items | Clear positives | Uncertain | False positives | Notes |
|---|---|---|---|---|---|
| expressjs/express | 15 | 9 | 5 | 1 | deprecated `url.parse` inside a test file |
| junegunn/fzf | 15 | 10 | 2 | 3 | support questions phrased as statements |
| BurntSushi/ripgrep | 15 | 11 | 3 | 0 | red nightly CI confirmed from job logs |
| sindresorhus/awesome | 1 | 0 | 1 | 0 | meta thread about link checking |
| psf/requests | 15 | 11 | 3 | 1 | title says "Duplicates #4514" |
| tqdm/tqdm | 15 | 13 | 0 | 2 | `to-merge` and `p5-wont-fix` labels missed |
| jd/tenacity | 5 | 5 | 0 | 0 | |
| google/gson | 15 | 15 | 0 | 0 | |
| sinatra/sinatra | 6 | 6 | 0 | 0 | |
| jqlang/jq | 15 | 8 | 6 | 1 | feature with "error" in title ranked as a fix |
| guzzle/guzzle | 1 | 1 | 0 | 0 | |
| vitejs/vite | 15 | 12 | 3 | 0 | |
| django/django | 0 | | | | issues live in Trac; stated in the profile |
| **Total** | **133** | **101** | **23** | **8** | precision 93% on decided items, 83% counting uncertain as wrong |

All eight false positives had mechanical causes and were fixed the same day
with unit tests: deprecated-only API hits inside tests, feature labels losing
to incidental defect words, "duplicate" in titles, in-flight labels such as
`to-merge`, and `won't fix` spelled `p5-wont-fix`. The remaining weakness is
lexical: support questions written as statements ("multiline PDF search")
pass as defects on trackers without labels; the optional language-model review
exists for exactly that and is unvalidated live for lack of credentials.

Earlier passes the same day removed another twenty-odd defects found the same
way (cross-repository PR links, docs-site anchors, Trac ticket numbers,
approved-but-unmerged PRs, quoted comment text, and so on); the unit tests
and `docs/design.md` record each one.

How to repeat: run the sweep with `--json`, then
`node scripts/summarize-reports.mjs <dir>` and read the evidence of every item,
not only the titles.

## Second audit: held-out repositories

After the fixes above, a second sweep over repositories not used for tuning
(plus fzf as a control) was audited the same way. These numbers are from the
first pass over the held-out set, before any fix prompted by it, so they are
the honest estimate of how the analyzers generalise.

| Repository | Items | Clear positives | Uncertain | False positives | Main cause |
|---|---|---|---|---|---|
| python-pillow/Pillow | 7 | 4 | 0 | 3 | test index consumed by image fixtures; `Tests/` capitalised; `winbuild/` scripts |
| pallets/flask | 7 | 6 | 1 | 0 | dev-only lockfile vulnerabilities (real, now marked development) |
| junegunn/fzf (control) | 15 | 13 | 2 | 0 | noun-phrase titles now treated as requests |
| mochajs/mocha | 15 | 11 | 1 | 3 | `core-team` labels; mocha testing its own `describe.skip`; emoji anchor |
| prettier/prettier | 15 | 12 | 0 | 3 | snapshot-driven suite never names modules |
| astral-sh/ruff | 15 | 11 | 3 | 1 | docs page generated at build time |
| hashicorp/terraform | 15 | 13 | 2 | 0 | was wrongly `closed` by "we may not review PRs which fail tests"; fixed before this count |
| **Total** | **89** | **70** | **9** | **10** | precision 88% on decided items, 79% counting uncertain as wrong |

Causes were again mechanical and were fixed with tests the same day: code tests
indexed before data files and every candidate confirmed with `git grep`;
snapshot counts compared against spec files; three-letter format names (tga,
pdf) count as test-name words; maintainer-only labels; test frameworks skip the
skipped-test analyzer; anchors compared by alphanumeric skeleton (emoji, MkDocs
`{: #id }`); generated docs pages and directories detected; owner/repo
shorthand is not a path; doc-comment TODOs are not debt; a refusal needs a
subject and an unconditional verb. On re-run, 87 items remained and no false
positive I could identify was left; that figure is less trustworthy than the
pre-fix one because the same person judged and fixed.

Where the lexical approach still falls short: requests written as statements on
unlabelled trackers, and "issues" that are really announcements. The optional
language-model review targets exactly these and remains unvalidated live.

## Independent check: maintainers' close reasons

Self-judged audits share the judge with the author. GitHub records why each
issue was closed, so `scripts/backtest-issues.ts` grades the lexical issue
classifier against that: it runs the assessment on recently closed issues as
they looked while open (clock set to the close time; comments from the last two
days before closing and merged PR links removed so the verdict cannot leak) and
compares with the state reason. COMPLETED counts as worth acting on, NOT_PLANNED
and DUPLICATE as not. Issues closed without a reason are not graded.

| Repository | Graded | Completed | Not planned / dup | Accepted | Precision | Precision excl. duplicates | Recall |
|---|---|---|---|---|---|---|---|
| jd/tenacity | 150 | 107 | 43 | 41 | 80% | 80% | 31% |
| junegunn/fzf | 150 | 149 | 1 | 75 | 100% | 100% | 50% |
| BurntSushi/ripgrep | 150 | 92 | 58 | 58 | 91% | 98% | 58% |
| psf/requests | 150 | 97 | 53 | 71 | 80% | 88% | 59% |
| expressjs/express | 150 | 109 | 41 | 43 | 81% | 92% | 32% |
| tqdm/tqdm | 150 | 139 | 11 | 47 | 100% | 100% | 34% |
| google/gson | 150 | 91 | 59 | 65 | 69% | 74% | 49% |
| sinatra/sinatra | 150 | 139 | 11 | 58 | 95% | 95% | 40% |
| mochajs/mocha | 132 | 112 | 20 | 67 | 94% | 98% | 56% |
| prettier/prettier | 150 | 133 | 17 | 87 | 92% | 94% | 60% |
| python-pillow/Pillow | 150 | 141 | 9 | 73 | 100% | 100% | 52% |
| vitejs/vite | 150 | 113 | 37 | 88 | 85% | 90% | 66% |
| **All** | **1782** | **1422** | **360** | **773** | **89%** | **93%** | **49%** |

The base rate of "completed" among graded issues is 80%, so accepting at random
would be right 80% of the time; the classifier is right 89% of the time (93%
excluding duplicates), which removes about half of the non-actionable items
while keeping 49% of the actionable ones. Every tracker is above its own base
rate; gson is the weakest (69% against 61%) because its issue template applies
`bug` to everything and many such reports are user error. Recall is low by design: the lexical pass only accepts what it can back
with labels, maintainer confirmation, defect language or a reproduction.

Caveats: "completed" is a maintainer's bookkeeping, not proof that an outsider
could have fixed the issue (fzf closes nearly everything as completed, so its
100% says little); the sample is the 150 most recently updated closed issues
per repository; and the lexical pass ran without the optional model review.

Repeat with `node scripts/backtest-issues.ts owner/name ... --issues 150`,
and `--show fp` or `--show fn` to list the misses.

## Independent check: did maintainers act on code findings?

`scripts/backtest-code.ts` analyzes each repository at the commit from a year
earlier (clone-based analyzers only, clock at that commit, every cluster kept)
and asks today's HEAD whether each flagged thing is gone: the deprecated call
or CI rule no longer matches, the TODO line is gone, the broken link line
changed, a test now names the untested module. As a control it takes three
random lines from each flagged file at the old commit and checks whether they
survived; that is ordinary churn.

Twenty-nine repositories (the validation set plus scrapy, celery, httpx, black,
pytest, pydantic, rich, axios, gin, cobra, tokio, fastapi), commits from
2025-10-23, graded against HEAD on 2026-10-23:

| Kind | Findings | Gone at HEAD | File gone | Resolution rate |
|---|---|---|---|---|
| control (random lines, same files) | 321 | 41 | 9 | 13% |
| ci_rot | 9 | 8 | 0 | 89% |
| broken_link (relative) | 10 | 5 | 0 | 50% |
| deprecation | 13 | 5 | 0 | 38% |
| tech_debt (TODO/FIXME) | 44 | 14 | 5 | 36% |
| test_gap (untested file) | 7 | 0 | 0 | 0% |

CI rot is acted on at seven times the churn rate: what it flags, maintainers
fix. Broken links, deprecations and self-admitted debt are acted on at three to
four times churn, in line with their mid-range value priors. None of the seven
untested-file findings gained a test within a year; that prior was lowered
(base 0.45 to 0.35) so such findings rank below deprecations and links unless
the file is both hot and central. Samples are still small for every kind but
tech_debt and the control; the eval package's broader run will refine them.
These repositories produced few code findings a year ago (0 to 7 each), which
is itself consistent with the analyzers being evidence-driven rather than noisy.

Repeat with `node scripts/backtest-code.ts owner/name ... --days 365`.

### Second set

A disjoint twenty-repository set, same procedure, run on 2026-10-23 before the
"targeted commit" grading was added: sqlalchemy, httpie, aiohttp, pip-tools,
pip, mitmproxy, sphinx, jinja, werkzeug, undici, fastify, koa, got, gorilla/mux,
urfave/cli, BurntSushi/toml, serde, clap, caddy (boto3's year of history
exceeded the 5000-commit log cap and was skipped).

| Kind | Findings | Gone at HEAD | File gone | Resolution rate |
|---|---|---|---|---|
| control (random lines, same files) | 312 | 18 | 0 | 6% |
| broken_link (relative) | 16 | 10 | 0 | 63% |
| ci_rot | 30 | 13 | 0 | 43% |
| tech_debt (TODO/FIXME) | 25 | 6 | 0 | 24% |
| test_gap (untested file) | 9 | 2 | 1 | 25% |
| deprecation | 19 | 2 | 0 | 11% |
| docs_drift | 5 | 0 | 0 | 0% |
| hygiene (py.typed) | 1 | 0 | 0 | 0% |

Every kind but docs_drift again beats churn, and the ordering of the first set
holds except for deprecations, which fell from 38% to 11% (2 of 19). Reading
the unmoved ones with `--show deprecation` showed analyzer faults rather than
ignored debt: pip's seven were two files under `src/pip/_vendor/` (a vendored
directory name the inventory did not know), one `.pyi` stub, and four
function-local `from distutils ...` imports next to a `_distutils.py`
compatibility module, all of which import the removed module on purpose. The
analyzer now treats `_vendor`, `vendored`, `3rdparty` and `extern` as vendored,
skips stubs, counts deferred imports and compat/shim/polyfill/backport modules
(or a module named after what it wraps) as guarded, and reports a rule only when
some use in non-test source is unguarded; pip then yields no deprecation finding
at that commit. The prior is unchanged.

Regraded with the final analyzer and the eval package's grading (an excerpt
still present elsewhere in the tree is "moved", not gone; a removal counts as
targeted when the first commit after the old one in which the excerpt is absent
touched at most 50 files):

| Kind | Findings | Gone at HEAD | By a targeted commit | Gone rate | Targeted rate |
|---|---|---|---|---|---|
| control (random lines, same files) | 267 | 26 | 13 | 10% | 5% |
| broken_link (relative) | 16 | 10 | 5 | 63% | 31% |
| ci_rot | 30 | 13 | 12 | 43% | 40% |
| tech_debt (TODO/FIXME) | 24 | 8 | 2 | 33% | 8% |
| test_gap (untested file) | 9 | 2 | 0 | 25% | 0% |
| deprecation | 0 | - | - | - | - |
| docs_drift | 5 | 0 | 0 | 0% | 0% |

CI rot is the kind maintainers fix deliberately (12 of 13 removals were
targeted commits, eight times the control's targeted rate); broken links are
fixed on purpose about half the time; TODO lines mostly disappear in refactors
(2 of 8 targeted), which matches the eval package's reading and keeps the
`tech_debt` cap at two per report. The five remaining deprecation findings were
all `datetime.utcnow()` in werkzeug's `examples/` and an httpie docs helper
script; merely deprecated calls in examples, docs scripts, tools and benchmarks
are now treated like those in tests (not reported on their own), which is why
the final table has no deprecation row for this set. `ci_rot` at 43% gone (13 of 30) is lower
than the 89% of the first because this set's findings include many "workflow
red on the default branch" items, which maintainers fix by re-running or by
changing the test, neither of which the excerpt check sees.

## Self-analysis and the already-fixed check

Running the analyzer on gitgoblin itself (the CLI session's report, 2026-10-23)
produced four false positives of one shape: files that *define* detector
patterns were reported for them. `deprecation-rules.ts` and a test fixture
matched the Node rules for `url.parse`, `new Buffer` and `fs.exists`; a test
with `it.skip` inside a string literal counted as a skipped test. Fix: pattern
matchers now run over source with string, regex and template literals and
comments blanked (`src/util/mask.ts`, positions preserved so line numbers and
excerpts stay right). Re-run by the CLI session: one opportunity left, the real
one (an outdated esbuild).

The first live engine run then took tenacity #511 (third-ranked, score 0.59)
and spent a dollar discovering it had been fixed on main eight months earlier
by a PR that never referenced the issue. The issues analyzer now asks the clone
two cheap questions for every accepted defect: is the code the issue quotes
(fenced blocks, Python traceback source lines) still at HEAD, and if not, was
it in the files the issue names at the commit current when the issue was
filed; and did later commits on those files cite the issue number. A positive
answer lowers confidence (x0.6, or x0.5 for a citing commit) and puts a risk
first in the list with the file or commit as evidence, and lowers value (x0.75)
because a fixed bug is worth little. Issues quote their own reproduction more
often than the project's code, so the check also reads permalinks into the
repository (`blob/<sha>/path#L..`) and grades the linked lines, which is what
#511 carried. Confirmed live on tenacity on 2026-10-23: #511's confidence went
from 0.60 to 0.36 with the risk "Code quoted in the issue (\"# NOTE(sileht):
can't really happen, but we must please mypy\") was in tenacity/before.py when
it was filed and is gone at HEAD; it may already be fixed" and the file as
evidence; the other three issue opportunities were untouched.

### Drift check across twelve repositories

A live sweep (flask, requests, httpx, click, pydantic, aiohttp, fastapi,
tenacity, rich, attrs, pytest, urllib3; 221 issue opportunities) flagged 23:
10 "quoted code gone", 13 "files changed since filing". Reading the commit that
changed each quoted line showed the strong signal right for tenacity #511 and
plausibly for aiohttp #6978, but wrong where a line had merely gained an
argument in the middle (pydantic #9204, urllib3 #2751) or was a 12-character
import fragment (urllib3 #1981). Changes: a line whose first two thirds survive
counts as edited in place; permalinked lines pass the same distinctiveness
filter as quoted ones; and the "files changed" signal is now a note (five or
more commits) with no effect on the score, because nothing measured supports a
penalty. The sweep also showed docs_drift's five unmoved findings were one
false positive: pip-tools declares `--upgrade-package` as an assigned
`click.option(` with the flag on a later line, which the collector did not
read; fixed with a test. Rerun the sweep after any change to
`src/analyzers/issue-drift.ts`.
