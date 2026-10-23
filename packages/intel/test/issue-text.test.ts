import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ISSUE_BODY, issueBody, problemStatement } from "../src/analyzers/issue-text.ts";
import { plainText } from "../src/analyzers/issues.ts";
import { truncate } from "../src/util/text.ts";

// testing-library/eslint-plugin-testing-library#1401, a GitHub issue form.
const form = readFileSync(join(import.meta.dirname, "fixtures", "issue-form-1401.md"), "utf8");

describe("issue text", () => {
  it("starts the summary at the bug description, not the template's questions", () => {
    const summary = truncate(plainText(problemStatement(form)), 300);
    expect(summary.startsWith("The autofix seems to work line by line.")).toBe(true);
    expect(summary).not.toMatch(/Troubleshooting|Plugin version|7\.16\.2/);
  });

  it("keeps the reproduction, versions and error output for an agent, and drops yes/no boilerplate", () => {
    const body = issueBody(form);
    expect(body).not.toMatch(/Have you read the Troubleshooting section/);
    expect(body).toContain("### Plugin version\n\n7.16.2");
    expect(body).toContain("test('submits', async () => { await waitFor(() => { fireEvent.click(button); }); });");
    expect(body).toContain("Fix objects must not be overlapped in a report.");
  });

  it("drops comments, checklists and empty answers, and caps the length", () => {
    const md = "<!-- please fill in -->\n### Checklist\n\n- [x] I searched existing issues\n\n### Describe the bug\n\nIt crashes on empty input.\n\n### Additional context\n\n_No response_\n";
    expect(issueBody(md)).toBe("### Describe the bug\n\nIt crashes on empty input.");
    expect(problemStatement(md)).toBe("It crashes on empty input.");
    const long = issueBody(`### Describe the bug\n\n${"x".repeat(30_000)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_ISSUE_BODY);
    expect(long.endsWith("[issue text truncated]")).toBe(true);
  });

  it("leaves a plain issue without headings as it is", () => {
    expect(problemStatement("Calling `f()` twice raises KeyError.\n\n```py\nf(); f()\n```")).toBe("Calling `f()` twice raises KeyError.\n\n```py\nf(); f()\n```");
  });
});
