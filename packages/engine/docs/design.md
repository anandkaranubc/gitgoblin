# gitgoblin engine: design

Status: v0.1 (2026-10-22). Owner: the engine package. Inputs come from `@gitgoblin/intel`
(repository profile + validated contribution opportunity); the engine never modifies that package.

## Intent

Turn one validated opportunity into one reviewable pull request, or stop with a clear reason.
Optimise for contributions a maintainer would merge, not for throughput. Every external write
(push, PR creation, comments) happens only after a human approves the prepared result.

## Non-goals (v0.1)

- Finding or ranking opportunities (intel/discovery own this).
- Running many tasks in parallel or a scheduler.
- Docker/VM isolation (interface allows it later; v0.1 uses the Agent SDK sandbox + hooks for the
  agent and an OS sandbox for the repository's own commands).
- Reacting to CI or maintainer review after the PR is open.

## Pipeline

```
intake -> workspace -> baseline -> orient -> plan -> implement -> verify -> review -> prepare -> [approve] -> publish
                                     ^                     |          |        |
                                     |      retry          |  retry   | revise |
                                     +---------------------+----------+--------+   (bounded, loop-detected)
```

| Phase | Who | Output artifact | Notes |
|---|---|---|---|
| intake | code | `Task` | Projects intel contracts onto the few fields the engine reads. |
| workspace | code | `Workspace` | Clone (or `git worktree` from a local checkout) at the profiled SHA, new branch. |
| baseline | code | `Verification` | Run the repo's own test/lint/typecheck before touching anything, so pre-existing failures are never blamed on us. |
| orient | agent (sandboxed, may write a reproduction test) | `Investigation` | Locate code, confirm commands, reproduce the problem, judge feasibility. |
| plan | same session | `ChangePlan` | Files, steps, tests to add, explicit out-of-scope list, risks. |
| implement | same session, write access | `ImplementationNotes` + diff | Follows the plan; must add or update tests. |
| verify | code | `Verification` | Repo commands again, compared with baseline: a check "regressed" if it passed before and fails now. Diffs are always measured against the base commit, not HEAD. |
| review | fresh agent, read-only | `Review` | Sees issue, plan, diff, verification evidence; never sees the implementer's transcript. Must be skeptical. |
| prepare | code | commit + `pr.md` + `report.md` | Squash everything since the base commit (agents sometimes commit as they go) into one commit in the repo's style; PR body with evidence. Status `awaiting_approval`. |
| publish | code, after explicit approval | PR URL | GitHub only for now: fork if needed, push, `gh pr create --draft`. Other forges: push by hand. |

Orient, plan and implement share one agent session (resumed) because splitting the implementer's
context loses the reasons behind decisions. Review deliberately does not share it: independence is
the point of a second reader.

## Decisions

`policy.ts` is a pure, unit-tested function set. It is the only place that decides whether to
continue, retry, escalate (needs a human) or stop:

- intake: an issue already in flight or a triage (reply-only) task -> stop; a stale pull request to
  revive, or a hygiene item naming no files -> escalate, because those start with a conversation.
- orient says `stop` (not feasible, wrong premise, already fixed) -> stop with the reasons.
- orient says `needs_human` or the plan touches more files than the limit or protected paths
  (CI workflows, release config, secrets) -> escalate with questions.
- the diff touches more files than the limit or a protected path, or adds something that looks
  like a secret -> escalate (the plan is a promise; the diff is what happened).
- verify fails -> retry implement with the failure output, up to `maxImplementRounds`;
  identical failure signature twice -> escalate (loop detected).
- review `revise` -> retry implement with findings, up to `maxReviewRounds` and within
  `maxImplementRounds`; a blocker that survives a revise round -> escalate. review `reject` ->
  escalate. The commit must equal the reviewed diff, or the run escalates.
- budget (USD, wall clock) exceeded at any gate -> stop.
- a phase interrupted by a transient failure (`error_during_execution`: connection or server
  error mid-run) is resumed once in the same session; a second failure fails the run. Out of turns
  or budget gets one tool-free wrap-up turn so the report says where things stand.

Escalations and stops still write a full report so a human can pick up where the engine left off.

## Security boundaries

- Agent sessions run with `cwd` = workspace, `settingSources: []` (the target repo's
  `.claude/settings.json` and hooks are never loaded; its CLAUDE.md/AGENTS.md/CONTRIBUTING.md are read
  by the engine and quoted into the prompt instead).
- `permissionMode: "dontAsk"` with an explicit tool allowlist per phase; no interactive prompts.
- Agent SDK sandbox: writes limited to the workspace (never its `.git`) and temp dirs, nothing at
  all for the reviewer, no network, no unsandboxed escape (`allowUnsandboxedCommands: false`),
  credential files under the home directory unreadable, model keys hidden from shell commands.
  The engine refuses to run unsandboxed unless asked.
- The engine's own git calls disable repository hooks and the filesystem monitor, and publishing
  resets any repository-local credential helper, so nothing the agent writes into the checkout can
  run code on the host.
- Install and verification commands run on the host with an environment stripped of every
  credential, including model keys, and by default inside an OS sandbox of their own (`hostbox.ts`:
  `sandbox-exec` on macOS, bubblewrap on Linux when installed). Inside it, writes are limited to the
  workspace (never its `.git`), the temp directory and tool caches under the home directory;
  credential paths are unreadable; the network is cut except on localhost, and open only for the
  install phase. Python projects get a virtualenv and Ruby projects a `BUNDLE_PATH` under the run
  directory (`toolchain.ts`), on PATH for the repository commands and the agent alike, so installs
  land there instead of in the operator's interpreter. `checkIsolation: "sandbox"` fails the run
  when no OS sandbox exists; `"strict"` also hides the home directory from repository commands
  except toolchain and cache directories, the temp directory and the run's prefix (credential
  paths stay denied even inside those); `"none"` runs bare. The report says which happened. Commands the model discovers during orientation are
  accepted only as plain invocations of known tool runners: no shell operators, no inline code or
  preload flags, no paths outside the checkout, no installs or download-and-run forms. The install
  phase still runs the repository's own scripts with network access: use a container for
  repositories you do not trust.
- The agent edits the tree before verification runs on the host, so an edit to the files that decide
  what the check commands execute (package.json scripts, Makefiles, test-runner and linter config
  that is code, hook managers, package-manager settings) escalates before the checks run; a person
  reads that diff first. A test file the agent adds still runs under the repository's test command,
  inside the OS sandbox when there is one.
- Repository guidance (CONTRIBUTING.md, AGENTS.md, pull request templates) is quoted into prompts
  only when the path resolves to a regular file inside the checkout, so a symlink named
  CONTRIBUTING.md pointing at a credential file is skipped; the text is read as a bounded prefix and
  stripped of invisible control characters.
- PreToolUse hooks deny, regardless of mode: `git push`, remote changes, `gh`, network tools,
  package publishing, installing new packages, `sudo`, container/system tools, writes outside the
  workspace, writes into `.git/` and to protected paths. Hooks are best-effort text matching; the
  sandbox is the hard boundary.
- The agent subprocess gets a scrubbed environment: only PATH/HOME/locale basics plus Anthropic
  auth. `GH_TOKEN`, cloud credentials and similar never reach it.
- Publishing uses the operator's `gh` login from the engine process, never from an agent.

## Interfaces

- Input: `runContribution({ task })` or `runContribution({ profile, opportunity })`; `intake.ts`
  maps intel types to `Task`.
- `AgentRunner` is an interface; the SDK implementation lives in `agent.ts`. Tests inject a scripted
  runner so the orchestrator, policy and delivery are testable without a model.
- Every phase writes its artifact to `.gitgoblin/runs/<runId>/` plus `events.jsonl`; a run can be
  inspected or published later by id.

## Prior art borrowed

- Agentless / SWE-bench studies: reproduce first, verify against a baseline, keep patches small.
- Aider: lint/test auto-fix loop fed back verbatim; conventions files quoted into the prompt.
- SWE-agent: fewer, well-described tools beat many; output limits on command results.
- Anthropic's multi-agent guidance and Cognition's "don't build multi-agents": one context for the
  builder, separate context only where independence is the goal (review).
- Codex/Claude Code: approval modes and sandboxing as the safety boundary, not prompt instructions.
