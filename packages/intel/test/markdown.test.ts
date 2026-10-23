import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/report/markdown.ts";
import { AnalysisReport } from "../src/contracts.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("renderMarkdown", () => {
  it("names every opportunity by id so a reader can pass it to the CLI", () => {
    const report = AnalysisReport.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "tenacity.report.json"), "utf8")));
    const md = renderMarkdown(report);
    for (const o of report.opportunities) expect(md).toContain(`id \`${o.id}\``);
    expect(md).toContain("# jd/tenacity");
    expect(md).toContain("## Opportunities");
  });
});
