import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisReport } from "../src/contracts.ts";

const dir = join(import.meta.dirname, "..", "fixtures");

describe("fixtures", () => {
  it("every fixture report validates against the current schema", async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".report.json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = AnalysisReport.safeParse(JSON.parse(await readFile(join(dir, file), "utf8")));
      expect(parsed.success, `${file}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      if (parsed.success) {
        for (const o of parsed.data.opportunities) {
          expect(o.evidence.length).toBeGreaterThan(0);
          expect(o.factors.map((f) => f.name)).toEqual(["value", "feasibility", "welcomeness", "confidence", "novelty"]);
        }
      }
    }
  });
});
