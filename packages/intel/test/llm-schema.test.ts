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
