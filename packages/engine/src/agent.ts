import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildHooks, sandboxSettings, scrubEnv, toolsFor, type GuardContext, type ToolProfile } from "./guard.ts";
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
  onToolUse?: (phase: string, tool: string, summary: string) => void;
  onMessage?: (phase: string, message: SDKMessage) => void;
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

/** Runs phases on the Claude Agent SDK with the engine's security boundaries applied. */
export function createSdkRunner(opts: SdkRunnerOptions): AgentRunner {
  const env = opts.env ?? scrubEnv();
  const isolation = opts.isolation ?? "sandbox";
  const costs = new SessionCostTracker();

  async function runOnce<T>(spec: PhaseSpec<T>, prompt: string, overrides: Partial<Options>): Promise<PhaseResult<T> & { needsWrapUp: boolean }> {
    const denials: PhaseResult<T>["denials"] = [];
    const guard: GuardContext = {
      workspace: opts.workspace,
      task: opts.task,
      profile: spec.profile,
      ...(opts.readRoots ? { readRoots: opts.readRoots } : {}),
      onDeny: (tool, reason) => denials.push({ tool, reason }),
    };
    const tools = toolsFor(spec.profile);
    const options: Options = {
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
      ...(isolation === "sandbox" ? { sandbox: sandboxSettings(opts.workspace, spec.profile) } : {}),
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

    try {
      for await (const message of query({ prompt, options })) {
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
            errors.push(message.subtype, ...message.errors);
          }
        }
      }
    } catch (err) {
      // The SDK throws after yielding an error result; keep what we learned.
      const msg = err instanceof Error ? err.message : String(err);
      if (!errors.includes(msg)) errors.push(msg);
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
    };
  }

  return {
    async run<T>(spec: PhaseSpec<T>): Promise<PhaseResult<T>> {
      const first = await runOnce(spec, spec.prompt, {});
      if (first.ok || !first.needsWrapUp || !first.sessionId) return first;
      // Out of turns or budget: give the session one tool-free chance to report its state.
      const wrap = await runOnce({ ...spec, resume: first.sessionId }, WRAP_UP_PROMPT, { allowedTools: [], maxTurns: 2, maxBudgetUsd: 1 });
      return {
        ...wrap,
        costUsd: first.costUsd + wrap.costUsd,
        turns: first.turns + wrap.turns,
        durationMs: first.durationMs + wrap.durationMs,
        errors: [...first.errors, ...wrap.errors],
        denials: [...first.denials, ...wrap.denials],
      };
    },
  };
}
