import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildHooks, sandboxSettings, scrubEnv, toolsFor, type GuardContext, type ToolProfile } from "./guard.ts";
import { OFFLINE_ENV } from "./hostbox.ts";
import type { Task } from "./types.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One model session with a structured result. Orient, plan, implement and review are all phases. */
export interface PhaseSpec<T> {
  name: string;
  systemPrompt: string;
  prompt: string;
  schema: z.ZodType<T>;
  profile: ToolProfile;
  /** Session to continue, so later phases keep the context of earlier ones. */
  resume?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Wall-clock limit for this phase; the session is aborted when it passes. */
  timeoutMs?: number;
  model?: string;
  effort?: Effort;
}

export interface PhaseResult<T> {
  ok: boolean;
  output?: T;
  /** Final assistant text, useful when `ok` is false. */
  text: string;
  sessionId?: string;
  /** Spend attributable to this phase alone. */
  costUsd: number;
  turns: number;
  durationMs: number;
  errors: string[];
  denials: { tool: string; reason: string }[];
}

export interface AgentRunner {
  run<T>(spec: PhaseSpec<T>): Promise<PhaseResult<T>>;
}

/**
 * `total_cost_usd` on a resumed session already includes the earlier turns, so a phase's own
 * spend is the increase over what its session had cost before.
 */
export class SessionCostTracker {
  private readonly totals = new Map<string, number>();

  delta(sessionId: string | undefined, resumedFrom: string | undefined, total: number): number {
    const prior = resumedFrom ? (this.totals.get(resumedFrom) ?? 0) : 0;
    const increment = Math.max(0, total - prior);
    if (sessionId) this.totals.set(sessionId, total);
    if (resumedFrom) this.totals.set(resumedFrom, total);
    return increment;
  }
}

export interface SdkRunnerOptions {
  workspace: string;
  task: Pick<Task, "kind">;
  /** "sandbox" (default) uses the Agent SDK sandbox; "none" relies on hooks alone. */
  isolation?: "sandbox" | "none";
  model?: string;
  env?: Record<string, string>;
  readRoots?: string[];
  /** Directories outside the workspace the agent's shell may write, such as the run's toolchain prefix. */
  extraWrite?: string[];
  /** The run's own temp directory, used instead of the shared ones when sandboxed. */
  tmp?: string;
  onToolUse?: (phase: string, tool: string, summary: string) => void;
  onMessage?: (phase: string, message: SDKMessage) => void;
  /** The SDK's query function; tests substitute a scripted one. */
  query?: typeof query;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const pick = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const value = pick("command") ?? pick("file_path") ?? pick("pattern") ?? pick("notebook_path") ?? "";
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

const WRAP_UP_PROMPT =
  "You have used the turns or budget available. Stop working and return the requested structured output now, " +
  "describing honestly what is done, what is not, and anything a human must know.";
const RESUME_PROMPT =
  "The previous attempt was interrupted by a transient error before you returned a result. Continue from where you were, " +
  "check the state of the workspace rather than assuming your last edits landed, and return the requested structured output.";

/** Runs phases on the Claude Agent SDK with the engine's security boundaries applied. */
export function createSdkRunner(opts: SdkRunnerOptions): AgentRunner {
  const isolation = opts.isolation ?? "sandbox";
  // The agent's shell has no network inside the sandbox; package managers should know it.
  const tmp = isolation === "sandbox" && opts.tmp ? { TMPDIR: opts.tmp, TMP: opts.tmp, TEMP: opts.tmp } : {};
  const env = { ...(opts.env ?? scrubEnv()), ...(isolation === "sandbox" ? OFFLINE_ENV : {}), ...tmp };
  const costs = new SessionCostTracker();
  const run = opts.query ?? query;

  /** `endsAt` is the phase's deadline: a resume or a wrap-up continues the phase, it does not get a fresh one. */
  async function runOnce<T>(spec: PhaseSpec<T>, prompt: string, overrides: Partial<Options>, endsAt?: number): Promise<PhaseResult<T> & { needsWrapUp: boolean; interrupted: boolean }> {
    const denials: PhaseResult<T>["denials"] = [];
    const guard: GuardContext = {
      workspace: opts.workspace,
      task: opts.task,
      profile: spec.profile,
      ...(opts.readRoots ? { readRoots: opts.readRoots } : {}),
      onDeny: (tool, reason) => denials.push({ tool, reason }),
    };
    const tools = toolsFor(spec.profile);
    const abortController = new AbortController();
    let timedOut = false;
    const deadline =
      endsAt !== undefined
        ? setTimeout(() => {
            timedOut = true;
            abortController.abort();
          }, endsAt - Date.now())
        : undefined;
    const options: Options = {
      abortController,
      cwd: opts.workspace,
      systemPrompt: spec.systemPrompt,
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: tools.allowedTools,
      disallowedTools: tools.disallowedTools,
      hooks: buildHooks(guard),
      env,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      outputFormat: { type: "json_schema", schema: z.toJSONSchema(spec.schema, { target: "draft-7" }) },
      persistSession: true,
      ...(spec.model ?? opts.model ? { model: spec.model ?? opts.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.resume ? { resume: spec.resume } : {}),
      ...(isolation === "sandbox" ? { sandbox: sandboxSettings(opts.workspace, spec.profile, opts.extraWrite ?? [], opts.tmp) } : {}),
      ...overrides,
    };

    const started = Date.now();
    let text = "";
    let sessionId: string | undefined;
    let total = 0;
    let turns = 0;
    const errors: string[] = [];
    let structured: unknown;
    let needsWrapUp = false;
    let interrupted = false;

    try {
      for await (const message of run({ prompt, options })) {
        opts.onMessage?.(spec.name, message);
        if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
        if (message.type === "assistant" && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === "text") text = block.text;
            if (block.type === "tool_use") opts.onToolUse?.(spec.name, block.name, summarizeToolInput(block.name, block.input));
          }
        }
        if (message.type === "result") {
          sessionId = message.session_id;
          total = message.total_cost_usd;
          turns = message.num_turns;
          if (message.subtype === "success") {
            structured = message.structured_output;
            if (message.result) text = message.result;
          } else {
            needsWrapUp = message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd";
            // A connection or server failure mid-run; the session itself is intact and can be resumed once.
            interrupted = message.subtype === "error_during_execution";
            errors.push(message.subtype, ...message.errors);
          }
        }
      }
    } catch (err) {
      // The SDK throws after yielding an error result; keep what we learned.
      const msg = err instanceof Error ? err.message : String(err);
      if (!errors.includes(msg)) errors.push(msg);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (timedOut) {
      errors.push(`${spec.name} timed out after ${Math.round((spec.timeoutMs ?? 0) / 1000)}s of wall-clock time`);
      // A deadline is the run's limit, not a transient failure: never resume it.
      interrupted = false;
    }

    const parsed = structured === undefined ? undefined : spec.schema.safeParse(structured);
    if (parsed && !parsed.success) errors.push(`structured output failed validation: ${parsed.error.message}`);
    return {
      ok: Boolean(parsed?.success),
      ...(parsed?.success ? { output: parsed.data } : {}),
      text,
      ...(sessionId ? { sessionId } : {}),
      costUsd: costs.delta(sessionId, spec.resume, total),
      turns,
      durationMs: Date.now() - started,
      errors,
      denials,
      needsWrapUp,
      interrupted,
    };
  }

  const combine = <T>(a: PhaseResult<T>, b: PhaseResult<T>): PhaseResult<T> => ({
    ...b,
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    errors: [...a.errors, ...b.errors],
    denials: [...a.denials, ...b.denials],
  });

  return {
    async run<T>(spec: PhaseSpec<T>): Promise<PhaseResult<T>> {
      const endsAt = spec.timeoutMs ? Date.now() + spec.timeoutMs : undefined;
      const timeLeft = () => endsAt === undefined || endsAt > Date.now();
      let first = await runOnce(spec, spec.prompt, {}, endsAt);
      if (!first.ok && first.interrupted && first.sessionId && timeLeft()) {
        // One resume after a transient failure; a second failure is reported, not retried.
        const again = await runOnce({ ...spec, resume: first.sessionId }, RESUME_PROMPT, {}, endsAt);
        first = { ...combine(first, again), needsWrapUp: again.needsWrapUp, interrupted: again.interrupted };
      }
      if (first.ok || !first.needsWrapUp || !first.sessionId || !timeLeft()) return first;
      // Out of turns or budget: give the session one tool-free chance to report its state.
      const wrap = await runOnce({ ...spec, resume: first.sessionId }, WRAP_UP_PROMPT, { allowedTools: [], maxTurns: 2, maxBudgetUsd: 1 }, endsAt);
      return combine(first, wrap);
    },
  };
}
