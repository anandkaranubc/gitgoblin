# @gitgoblin/engine

The part of gitgoblin that turns one validated contribution opportunity into a reviewable pull
request: isolated workspace, investigation, plan, implementation, deterministic verification,
independent review, and a prepared PR that a human approves before anything is pushed.

Design and security boundaries: [docs/design.md](docs/design.md).

## Use

```bash
# From intel's analysis (gitgoblin-intel analyze owner/name --json > analysis.json); the id is the
# opportunity's `id` field in that report, such as opp-6fa0e219
# (gitgoblin-engine is packages/engine/src/cli.ts; `node src/cli.ts` works from the package directory)
gitgoblin-engine run --report analysis.json --opportunity opp-6fa0e219

# Or from a hand-written task (see examples/task.example.json and TaskSchema in src/types.ts)
gitgoblin-engine run --task task.json --confirm-plan

# Read what it did, then decide
gitgoblin-engine show <runId>
gitgoblin-engine publish <runId>          # pushes with your gh login, opens a draft PR, asks first
gitgoblin-engine clean <runId>            # frees the workspace (and its branch); report and diff stay
```

`publish` asks at a terminal and has no flag to skip the question; piped input is refused, so a
script or an agent with a shell cannot publish on its own. Code that has asked a person can call
`publishRun(runId, { approved: true })`.

Each run writes `.gitgoblin/runs/<runId>/`, which other tools may read:

| File | What it holds |
|---|---|
| `result.json` | the `RunResult`: status, reason, questions, cost, branch, workspace path |
| `task.json` | the `Task` the run worked on |
| `report.md` | the human-readable report, whatever the outcome |
| `events.jsonl` | one JSON event per line: phases, decisions, isolation, toolchain, install |
| `install-output.txt` | the install command's output, when it ran |
| `baseline.json`, `verification-<n>.json` | the repository's checks before and after |
| `investigation.json`, `plan.json`, `implementation-<n>.json`, `review-<n>.json` | each phase's structured output |
| `diff-<n>.patch` | the change as reviewed in round `n` |
| `pr.md`, `pr-title.txt`, `diff.patch`, `delivery.json` | the prepared pull request, when the run reached `awaiting_approval` |
| `workspace/` | the checkout (a clone, or a worktree of a local checkout); it stays until `clean` (or `cleanRun()`) removes it with its `gitgoblin/...` branch, which refuses a run still awaiting approval unless forced |

Requirements: Node 24, git, a Claude Code login or `ANTHROPIC_API_KEY` (the Agent SDK uses either),
and `gh auth login` for publishing. The agent's bash runs in the Agent SDK sandbox with no network;
pass `--no-sandbox` (together with `GITGOBLIN_UNSAFE_NO_SANDBOX=1`) only on platforms without one. The repository's own install and check commands
run on your machine with a credential-free environment and, by default, inside an OS sandbox
(`sandbox-exec` on macOS, `bwrap` on Linux when installed): writes limited to the checkout and tool
caches, credential files hidden, checks offline, and the install able to reach package registries
only, through a proxy the engine runs (`--install-network open` lets it reach any host;
`RunOptions.installHosts` adds a private registry; the proxy goes through your `HTTPS_PROXY` when
one is set). Python projects get a virtualenv under the run directory (so `pip install -e .` never
touches your interpreter) and Ruby projects a per-run `BUNDLE_PATH`. `--check-isolation sandbox`
makes the run fail when no OS sandbox is available; `strict` additionally hides your home
directory from those commands except toolchain and cache directories (nvm, pyenv, cargo, npm and
the like), which is the setting for repositories you do not trust; `none` turns the sandbox off,
for example when a tool needs to write outside those places. The install command still runs the
repository's own scripts: for repositories you do not trust, run the engine itself inside a
container.

## Library

```ts
import { runContribution, publishRun } from "@gitgoblin/engine";

const result = await runContribution({ profile, opportunity }, { workdir: ".gitgoblin", limits: { maxCostUsd: 5 } });
if (result.status === "awaiting_approval") {
  // show result.runDir/pr.md to a person, then:
  await publishRun(result.runId, { workdir: ".gitgoblin", approved: true });
}
```

`RunOptions.runnerFactory` swaps the model runner, which is how the tests drive the whole pipeline
without a model.

## Layout

| File | Role |
|---|---|
| `orchestrator.ts` | the pipeline and its gates |
| `policy.ts` | pure decisions: continue, retry, escalate, stop |
| `guard.ts` | tool allowlists, deny hooks, sandbox and environment scrubbing |
| `agent.ts` | Claude Agent SDK runner behind the `AgentRunner` interface |
| `prompts.ts` | phase prompts |
| `verify.ts` | runs the repository's own checks and compares with the baseline |
| `workspace.ts` | git: worktree or clone, diffs against the base commit, the single squashed commit |
| `exec.ts` | runs commands with timeouts, process-group kill and capped output |
| `hostbox.ts` | OS sandbox (sandbox-exec, bwrap) for the repository's own commands |
| `toolchain.ts` | per-run prefix for what the toolchain installs (Python virtualenv, bundler's gem path) and the Node package manager's writable caches |
| `journal.ts` | the run directory: events, artifacts, report |
| `deliver.ts` | commit message, PR text, push and PR creation via `gh` |
| `intake.ts` | maps `@gitgoblin/intel` contracts to the engine's `Task` |

## Develop

```bash
npm test                         # unit and pipeline tests, no model needed
npm run typecheck
GITGOBLIN_LIVE=1 npx vitest run test/live.test.ts   # real model on a fixture repo, costs money
```

The package runs from source like the rest of the monorepo: Node 24 strips the types, so there is
no build step. `erasableSyntaxOnly` in tsconfig keeps it that way.
