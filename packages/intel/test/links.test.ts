import { describe, expect, it } from "vitest";
import { anchorsIn, checkRelativeLink, extractLinks, probeUrl, slugify } from "../src/analyzers/links.ts";

describe("link extraction", () => {
  it("extracts markdown links, reference definitions and bare URLs but not images, badges, or code", () => {
    const md = `
# Title
See [the guide](docs/guide.md#setup) and [API](https://example.org/api "title").
![badge](https://img.shields.io/x.svg) [![ci](https://x.io/a.png)](https://ci.gitgoblin.test)
Visit https://nodejs.org/en/download/. Also <https://go.dev>.
[ref]: https://ref.gitgoblin.test/path
\`\`\`
[code](https://in-code.example.org)
\`\`\`
<a href="relative/page.html">x</a> mailto:someone@x.org http://localhost:3000
`;
    const targets = extractLinks("README.md", md).map((l) => l.target).sort();
    expect(targets).toEqual([
      "docs/guide.md#setup",
      "https://ci.gitgoblin.test",
      "https://go.dev",
      "https://nodejs.org/en/download/",
      "https://ref.gitgoblin.test/path",
      "relative/page.html",
    ]);
  });

  it("handles reStructuredText links", () => {
    const rst = "See `the docs <https://docs.gitgoblin.test>`_ and\n.. _target: ../other.rst\n";
    expect(extractLinks("docs/index.rst", rst).map((l) => l.target)).toEqual(["https://docs.gitgoblin.test", "../other.rst"]);
  });
});

describe("anchors and relative links", () => {
  it("slugifies like GitHub and collects explicit anchors", () => {
    expect(slugify("Getting Started: Install & Run!")).toBe("getting-started-install--run");
    const anchors = anchorsIn("# Intro\n## Intro\n<a name=\"custom\"></a>\n### `code` heading\n<h3 name=\"complete\">Shell completions</h3>\n");
    expect([...anchors]).toEqual(["intro", "intro-1", "custom", "code-heading", "complete"]);
  });

  it("resolves relative links against the document and reports missing targets", async () => {
    const files = new Map([["docs/guide.md", "# Setup\ntext"], ["README.md", ""], ["src/a.py", ""]]);
    const exists = (p: string) => files.has(p);
    const existsDir = (p: string) => p === "src" || p === "docs";
    const read = async (p: string) => files.get(p);
    const link = (path: string, target: string) => ({ path, line: 1, target, text: "" });
    expect(await checkRelativeLink(link("README.md", "docs/guide.md#setup"), exists, existsDir, read)).toBeUndefined();
    expect(await checkRelativeLink(link("README.md", "docs/guide.md#missing"), exists, existsDir, read)).toMatchObject({ problem: "missing-anchor" });
    expect(await checkRelativeLink(link("docs/guide.md", "../src/a.py"), exists, existsDir, read)).toBeUndefined();
    expect(await checkRelativeLink(link("docs/guide.md", "../src/"), exists, existsDir, read)).toBeUndefined();
    expect(await checkRelativeLink(link("docs/guide.md", "gone.md"), exists, existsDir, read)).toMatchObject({ problem: "missing-file", resolved: "docs/gone.md" });
    expect(await checkRelativeLink(link("README.md", "/src/a.py"), exists, existsDir, read)).toBeUndefined();
    expect(await checkRelativeLink(link("README.md", "#setup"), exists, existsDir, read)).toMatchObject({ problem: "missing-anchor" });
  });
});

describe("probeUrl", () => {
  const publicHost = { lookup: async () => ["93.184.216.34"] };
  const fake = (statuses: Record<string, number>, hostile?: string): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (hostile && url.includes(hostile)) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
      const method = init?.method ?? "GET";
      const status = statuses[`${method} ${url}`] ?? statuses[url] ?? 200;
      return new Response(null, { status });
    }) as typeof fetch;

  it("confirms 404 with GET after HEAD, treats 403 as unknown, and skips bot-hostile hosts", async () => {
    expect(await probeUrl("https://a.test/x", fake({ "HEAD https://a.test/x": 404, "GET https://a.test/x": 404 }), publicHost)).toMatchObject({ status: "broken", detail: "HTTP 404" });
    expect(await probeUrl("https://a.test/y", fake({ "HEAD https://a.test/y": 405, "GET https://a.test/y": 200 }), publicHost)).toMatchObject({ status: "ok" });
    expect(await probeUrl("https://a.test/z", fake({ "HEAD https://a.test/z": 403, "GET https://a.test/z": 403 }), publicHost)).toMatchObject({ status: "unknown" });
    expect(await probeUrl("https://www.linkedin.com/in/x", fake({}), publicHost)).toMatchObject({ status: "unknown" });
    expect(await probeUrl("https://gone.test/", fake({}, "gone.test"), publicHost)).toMatchObject({ status: "broken", detail: "host does not resolve" });
  });
});
