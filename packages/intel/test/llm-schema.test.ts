import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { IssueReview } from "../src/llm/issue-review.ts";

/**
 * The SDK turns the zod schema into JSON Schema at call time, so a schema feature it cannot
 * represent (a transform, a refinement) only fails against the real client. Build the format here,
 * with no network, so that failure shows up in the suite.
 */
describe("model review schema", () => {
  it("is representable as structured output", () => {
    const format = zodOutputFormat(z.object({ reviews: z.array(IssueReview) }));
    expect(format.type).toBe("json_schema");
    const parsed = format.parse(JSON.stringify({ reviews: [{ number: 1, verdict: "defect", actionable: true, maintainerStance: "unknown", problem: "p", quote: "q", rationale: "r", confidence: 0.5 }] }));
    expect(parsed.reviews[0]?.verdict).toBe("defect");
  });
});

describe("the Anthropic client wrapper", () => {
  it("loads nothing until the first call and explains failures by status", async () => {
    const { createAnthropicLlm, describeLlmError } = await import("../src/llm/client.ts");
    const llm = createAnthropicLlm({ model: "claude-opus-5-5" });
    expect(llm.model).toBe("claude-opus-5-5");
    expect(llm.usage.calls).toBe(0);
    expect(describeLlmError(Object.assign(new Error("Unauthorized"), { status: 401 }))).toMatch(/no valid Anthropic credentials/);
    expect(describeLlmError(Object.assign(new Error("slow down"), { status: 429 }))).toBe("Anthropic rate limit reached");
    expect(describeLlmError(Object.assign(new Error("boom"), { status: 500 }))).toBe("Anthropic API error 500: boom");
    expect(describeLlmError(new Error("The ANTHROPIC_API_KEY environment variable is missing"))).toMatch(/no Anthropic credentials found/);
  });
});
