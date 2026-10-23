/**
 * Spawns the real server through its launcher and talks to it over stdio, against GitHub and
 * ecosyste.ms. Enable with GITGOBLIN_E2E=1; a GitHub token (gh auth login or GITHUB_TOKEN) gives the
 * full signal set but is not required.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.GITGOBLIN_E2E === "1";
const launcher = new URL("../../bin/gitgoblin-mcp.mjs", import.meta.url).pathname;

function textOf(result: { content: unknown }): string {
  return (result.content as { text?: string }[]).map((b) => b.text ?? "").join("\n");
}

describe.skipIf(!enabled)("gitgoblin-mcp over stdio (live)", () => {
  const client = new Client({ name: "gitgoblin-e2e", version: "0" });

  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], stderr: "pipe" }));
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists the tools and carries instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("discover_repositories");
    expect(client.getInstructions()).toMatch(/gitgoblin/);
  });

  it("discovers repositories with progress", async () => {
    const progress: string[] = [];
    const result = await client.callTool(
      { name: "discover_repositories", arguments: { goal: "contribute", languages: ["typescript"], limit: 3 } },
      { onprogress: (p) => progress.push(p.message ?? ""), timeout: 120_000 },
    );
    expect(result.isError, textOf(result)).toBeFalsy();
    const structured = result.structuredContent as { results: { repository: string; score: number }[] };
    expect(structured.results.length).toBeGreaterThan(0);
    expect(structured.results.length).toBeLessThanOrEqual(3);
    expect(textOf(result)).toMatch(/1\. \S+\/\S+/);
    expect(progress.length).toBeGreaterThan(0);
  }, 150_000);

  it("explains, analyzes and briefs one repository", async () => {
    const explained = await client.callTool({ name: "explain_repository", arguments: { repository: "jd/tenacity", goal: "adopt" } }, { timeout: 60_000 });
    expect(explained.isError, textOf(explained)).toBeFalsy();
    expect(textOf(explained)).toContain("jd/tenacity");

    const analyzed = await client.callTool({ name: "analyze_repository", arguments: { repository: "jd/tenacity", max_opportunities: 5 } }, { timeout: 180_000 });
    expect(analyzed.isError, textOf(analyzed)).toBeFalsy();
    const report = analyzed.structuredContent as { nature: string; opportunities: { id: string }[]; commands: Record<string, string> };
    expect(report.nature).toBe("library");
    expect(report.commands.test).toMatch(/pytest|tox/);

    const first = report.opportunities[0];
    if (first) {
      const briefing = await client.callTool({ name: "get_opportunity", arguments: { repository: "jd/tenacity", opportunity_id: first.id } }, { timeout: 60_000 });
      expect(briefing.isError, textOf(briefing)).toBeFalsy();
      expect(textOf(briefing)).toContain("How to work on the project:");
    }
  }, 300_000);

  it("analyzes a Codeberg repository through Forgejo's public API", async () => {
    const analyzed = await client.callTool({ name: "analyze_repository", arguments: { repository: "https://codeberg.org/dnkl/foot", max_opportunities: 3 } }, { timeout: 300_000 });
    expect(analyzed.isError, textOf(analyzed)).toBeFalsy();
    const report = analyzed.structuredContent as { repository: string; url: string };
    expect(report.repository).toBe("dnkl/foot");
    expect(report.url).toBe("https://codeberg.org/dnkl/foot");
  }, 360_000);
});
