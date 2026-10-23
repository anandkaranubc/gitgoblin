/**
 * Every function that reads text an outsider controls (issue titles and bodies, comments, READMEs,
 * CONTRIBUTING, source files, workflow files, lockfiles) must stay fast on hostile input. A regular
 * expression that backtracks across a 64 KB line can freeze an analysis for hours, synchronously,
 * in the CLI or in a long-running MCP server. This sweep feeds each of them a set of adversarial
 * inputs at GitHub's issue-body limit and fails if any call takes longer than the ceiling.
 */
import { describe, expect, it } from "vitest";
import { CEILING_MS, FUNCTIONS, inputs } from "./redos-cases.ts";

describe("text processing on hostile input", () => {
  for (const [name, fn] of FUNCTIONS) {
    it(`${name} stays under ${CEILING_MS} ms on every adversarial 64 KB input`, () => {
      const slow: string[] = [];
      const time = (text: string) => {
        const started = performance.now();
        try {
          fn(text);
        } catch {
          // Throwing on garbage is acceptable; hanging is not.
        }
        return performance.now() - started;
      };
      for (const [label, text] of inputs()) {
        // A busy machine (parallel test files, CI neighbours) can stall one call; a slow pattern is slow every time.
        let ms = time(text);
        if (ms > CEILING_MS) ms = Math.min(ms, time(text));
        if (ms > CEILING_MS) slow.push(`${label}: ${Math.round(ms)} ms`);
      }
      expect(slow).toEqual([]);
    }, 600_000);
  }
});
