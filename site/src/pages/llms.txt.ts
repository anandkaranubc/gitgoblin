import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { description, href, repo } from "../lib/site";

/** A plain-text map of the site for language models and other tools, per llmstxt.org. */
export const GET: APIRoute = async ({ site }) => {
  const pages = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
  const abs = (path: string) => new URL(href(path), site).toString();
  const lines = [
    "# gitgoblin",
    "",
    `> ${description}`,
    "",
    "gitgoblin is in preview. Discovery and repository analysis work, through the gitgoblin command or an MCP server for AI coding agents; preparing a contribution with an AI agent is experimental. Install the command with `npm install -g gitgoblin`; the MCP server runs with `npx -y @gitgoblin/mcp`. The repository README says what works today.",
    "",
    "## Docs",
    "",
    ...pages.map((p) => `- [${p.data.title}](${abs(`/docs/${p.id}/`)}): ${p.data.description}`),
    "",
    "## Repository",
    "",
    `- [README](${repo.url}#readme): overview and what works today`,
    `- [Architecture](${repo.url}/blob/main/docs/architecture.md): packages, contracts and shared ideas`,
    `- [Etiquette](${repo.url}/blob/main/docs/etiquette.md): how gitgoblin behaves in other people's projects, including maintainer opt-out`,
    `- [Engine design](${repo.url}/blob/main/packages/engine/docs/design.md): the contribution pipeline and its security boundaries`,
    `- [Contributing](${repo.url}/blob/main/CONTRIBUTING.md): working on gitgoblin itself`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
