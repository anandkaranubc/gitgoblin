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

describe("greetings", () => {
  it("drops an opening salutation from the problem statement", () => {
    expect(problemStatement("Hello, I've reached code that is marked as unreachable in `before_log`.")).toBe("I've reached code that is marked as unreachable in `before_log`.");
    expect(problemStatement("Hi team! The parser drops trailing commas.")).toBe("The parser drops trailing commas.");
    expect(problemStatement("Highlighting breaks on long lines.")).toBe("Highlighting breaks on long lines.");
  });
});

describe("hostile and tricky issue bodies", () => {
  const timed = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };

  it("handles 64 KB adversarial bodies in linear time", () => {
    const bodies = [
      `# x${" ".repeat(65_000)}y`,
      "<!--".repeat(16_000),
      "<".repeat(65_000),
      "```\n".repeat(16_000),
      "![".repeat(32_000),
      `${"\n".repeat(30_000)}# a`,
    ];
    for (const body of bodies) {
      const ms = timed(() => { issueBody(body); problemStatement(body); plainText(body); });
      expect(ms, `${body.slice(0, 12)}...`).toBeLessThan(500);
    }
  });

  it("does not read comment lines inside code blocks as headings or boilerplate", () => {
    const body = "### Describe the bug\n\nCalling run() after init fails.\n\n```python\n# This is the problem line\n# I have to call init first\nimport foo\nfoo.run()\n```\n";
    expect(problemStatement(body).startsWith("Calling run() after init fails.")).toBe(true);
    expect(issueBody(body)).toContain("# I have to call init first\nimport foo\nfoo.run()\n```");
  });

  it("keeps real sections that share a word with template boilerplate", () => {
    const body = "## Validation errors are not shown\n\nWhen a form field is invalid, no message appears under it, so users cannot tell what to fix. This regressed in 4.2.\n";
    expect(issueBody(body)).toContain("no message appears under it");
    expect(problemStatement(body).startsWith("When a form field is invalid")).toBe(true);
  });

  it("drops template comments that span headings, keeps headings like 'Using F#', and caps cleanly", () => {
    const body = "<!--\n### Instructions\nPlease describe\n-->\n### Using F#\n\nThe F# compiler crashes.\n";
    expect(issueBody(body)).toBe("### Using F#\n\nThe F# compiler crashes.");
    const fenced = issueBody(`### Describe the bug\n\n\`\`\`\n${"a".repeat(30_000)}\n\`\`\`\n`);
    expect(fenced.endsWith("```\n\n[issue text truncated]")).toBe(true);
    const emoji = issueBody(`### Describe the bug\n\n${"😀".repeat(15_000)}`);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
