import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The one thing intel asks a language model for: a structured answer to a
 * grounded question. Kept tiny so tests can fake it and so the deterministic
 * core never depends on it.
 */
export interface LlmClient {
  readonly model: string;
  readonly usage: LlmUsage;
  /** Null when the model declined or its output did not match the schema. */
  parse<T extends Record<string, unknown>>(system: string, user: string, schema: z.ZodType<T>): Promise<T | null>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicLlmOptions {
  model?: string | undefined;
}

/**
 * Claude through the official SDK; credentials come from the environment or `ant auth login`.
 * The SDK is loaded on the first call, so callers that never enable the model review (and bundles
 * that leave the SDK out) pay nothing for it, and missing credentials surface as a budget note
 * rather than a crash.
 */
export function createAnthropicLlm(options: AnthropicLlmOptions = {}): LlmClient {
  const model = options.model ?? process.env.GITGOBLIN_MODEL ?? DEFAULT_MODEL;
  const usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let sdk: Promise<{ client: Anthropic; zodOutputFormat: typeof import("@anthropic-ai/sdk/helpers/zod").zodOutputFormat }> | undefined;
  const load = () =>
    (sdk ??= Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]).then(([{ default: AnthropicClient }, helpers]) => ({
      client: new AnthropicClient(),
      zodOutputFormat: helpers.zodOutputFormat,
    })));
  return {
    model,
    usage,
    async parse(system, user, schema) {
      const { client, zodOutputFormat } = await load();
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        // The system prompt is identical across batches, so it is the cache prefix.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { format: zodOutputFormat(schema) },
      });
      usage.calls++;
      usage.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      usage.outputTokens += response.usage.output_tokens;
      if (response.stop_reason === "refusal") return null;
      return response.parsed_output ?? null;
    },
  };
}

/** Human-readable reason an LLM call failed, for the report's budget notes. */
export function describeLlmError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/credentials file not found|ANTHROPIC_API_KEY|apiKey/i.test(message)) return "no Anthropic credentials found (set ANTHROPIC_API_KEY or run `ant auth login`)";
  // Judged by HTTP status rather than SDK error classes, so this module never loads the SDK just to classify.
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) return "no valid Anthropic credentials (set ANTHROPIC_API_KEY or run `ant auth login`)";
  if (status === 429) return "Anthropic rate limit reached";
  if (typeof status === "number") return `Anthropic API error ${status}: ${message}`;
  return message;
}
