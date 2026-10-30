import { trimEnd } from "../util/text.ts";
import { posix } from "node:path";

// Repository paths are POSIX on every OS; node:path's defaults would turn them into backslashes on Windows.
const { dirname, normalize } = posix;

import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { mapLimit } from "../util/limit.ts";
import { atxHeading } from "./issue-text.ts";
import { type Lookup, classifyHost, defaultLookup, requestStatus } from "../util/net.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

export interface DocLink {
  path: string;
  line: number;
  target: string;
  text: string;
}

const SKIP_URL = /^(mailto:|tel:|javascript:|#|\{\{|\$|<)|localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net)|\.example\b|your-?(username|org|repo|domain)|<[^>]+>|\.\.\.|…|\bplaceholder\b|^#?$|^\(\)$/i;
const BADGE_HOST = /shields\.io|badge|travis-ci\.(org|com)\/.*\.svg|codecov\.io\/gh\/.*\/graph|coveralls\.io\/repos\/.*badge|img\.|\.svg(\?|$)|\.png(\?|$)/i;
/** Hosts that answer automated requests with 403 or 999, never a trustworthy 404. */
const BOT_HOSTILE = /(^|\.)(linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|reddit\.com|t\.me|medium\.com|discord\.(gg|com)|npmjs\.com|crates\.io|pypi\.org|gitlab\.com|bitbucket\.org|amazon\.com|cloudflare\.com|udemy\.com|researchgate\.net|ieee\.org|acm\.org|sciencedirect\.com|springer\.com|wiley\.com)$/i;

/** Links in Markdown or reStructuredText, outside fenced code. */
export function extractLinks(path: string, text: string): DocLink[] {
  const links: DocLink[] = [];
  const lines = text.split("\n");
  let inFence = false;
  const rst = /\.(rst|txt)$/i.test(path);
  // reStructuredText named targets: `.. _Name: url`, referenced as `text <Name_>`_ or Name_.
  const rstTargets = new Map<string, string>();
  if (rst) for (const m of text.matchAll(/^\.\. _([^:\n]{1,300}):[ \t]*(\S{1,2000})[ \t]*$/gm)) rstTargets.set(m[1]!.trim().toLowerCase(), m[2]!);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^ {4,}\S/.test(line) && !/^\s*[-*]|^\s*\d+\./.test(lines[i - 1] ?? "")) continue;
    const push = (target: string, label: string) => {
      const t = trimEnd(target.trim(), ".,;:!?)");
      if (!t || SKIP_URL.test(t) || BADGE_HOST.test(t)) return;
      // Only http(s) and repository-relative links are checkable; irc:, ftp:, slack: and friends are not.
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^https?:/i.test(t)) return;
      // "mochajs/docs-legacy": a GitHub owner/repo shorthand, not a path in this repository.
      if (/^[\w.-]+\/[\w.-]+$/.test(t) && !/\.\w{1,5}$/.test(t) && !t.startsWith(".") && !/^(src|lib|docs?|test|tests|packages?|examples?|internal|cmd|pkg|app|bin|scripts?|crates?)\//i.test(t)) return;
      // "docs.example.org/path" without a scheme is a URL someone forgot to prefix, not a repository path.
      if (/^[\w-]+(\.[\w-]+)+\.(com|org|net|io|dev|edu|gov|co|uk|de|fr|rs|sh|app|ai|me|info|xyz)(\/|$)/i.test(t)) return;
      links.push({ path, line: i + 1, target: t, text: label.trim() });
    };
    if (rst) {
      for (const m of line.matchAll(/`([^`<\n]{0,500})<([^>\n]{1,2000})>`_/g)) {
        const target = m[2]!.trim();
        if (target.endsWith("_")) {
          const resolved = rstTargets.get(target.slice(0, -1).toLowerCase());
          if (resolved) push(resolved, m[1]!);
        } else push(target, m[1]!);
      }
      for (const m of line.matchAll(/^\.\. _[^:\n]{1,300}:[ \t]*(\S{1,2000})/g)) push(m[1]!, "");
      continue;
    }
    // Images are badges and screenshots; their rot is low value and often blocked for bots. Inline code is not a link.
    // Every span is bounded: an unclosed `[` on a 64 KB line must not make each later `[` rescan the rest of it.
    const withoutImages = line.replace(/`[^`]{0,500}`/g, "").replace(/!\[[^\]]{0,500}\]\([^)]{0,2000}\)/g, "").replace(/<img[^>]{0,2000}>/gi, "");
    for (const m of withoutImages.matchAll(/\[([^\]]{0,500})\]\([ \t]{0,20}<?([^)\s>]{1,2000})>?(?:[ \t]{1,20}"[^"]{0,500}")?[ \t]{0,20}\)/g)) if (!m[1]!.startsWith("^")) push(m[2]!, m[1]!); // [^1] is a footnote
    for (const m of withoutImages.matchAll(/^[ \t]{0,20}\[([^\]^][^\]]{0,500})\]:[ \t]*(\S+)/g)) push(m[2]!, m[1]!); // [^1]: is a footnote definition
    for (const m of withoutImages.matchAll(/<a\s[^>\n]{0,500}?href=["']([^"'\n]{1,2000})["']/gi)) push(m[1]!, "");
    for (const m of withoutImages.matchAll(/<(https?:\/\/[^>\s]{1,2000})>/g)) push(m[1]!, "");
    // Bare URLs not already inside a markdown link.
    const stripped = withoutImages.replace(/\]\([^)\n]{0,2000}\)/g, "]()").replace(/\]:[ \t]{0,20}\S{1,2000}/g, "]:").replace(/href=["'][^"'\n]{0,2000}["']/gi, "");
    for (const m of stripped.matchAll(/(?<![("'<\w`])https?:\/\/[\w.-]+[^\s<>"')\]`]*/g)) push(m[0], "");
  }
  return links;
}

export function isExternal(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** GitHub-style heading anchor. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^<>]+>/g, "")
    .replace(/[`*~]/g, "")
    // Underscores are emphasis only at word boundaries; intraword ones (allow_redirects) stay in the anchor.
    .replace(/(^|\s)_{1,3}|_{1,3}(?=\s|$)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/** Slug the way VitePress, Docusaurus and MkDocs do: every run of non-alphanumerics becomes one hyphen. */
export function siteSlugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^<>]+>/g, "")
    .replace(/[`*~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-{1,200}$/, "");
}

/** Anchors a Markdown file exposes, in GitHub style and in static-site style. */
export function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const heading = atxHeading(line) || undefined;
    if (heading) {
      const text = heading.replace(/[ \t]{0,10}\{:?[ \t]{0,10}#[^}\n]{1,500}\}[ \t]*$/, "");
      const base = slugify(text);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
      anchors.add(siteSlugify(text));
      // `{#id}` (Pandoc, VitePress) and `{: #id }` / `{ #id }` (MkDocs attribute lists)
      const explicit = /\{:?[ \t]{0,10}#([^\s}]{1,200})[^}\n]{0,500}\}/.exec(heading)?.[1];
      if (explicit) anchors.add(explicit);
    }
    // Any tag may carry an id or name anchor, e.g. ripgrep's <h3 name="complete">.
    for (const m of line.matchAll(/<\w{1,20}\s[^>\n]{0,500}?\b(?:name|id)=["']([^"'\n]{1,300})["']/gi)) anchors.add(m[1]!);
  }
  return anchors;
}

export interface RelativeCheck {
  link: DocLink;
  resolved: string;
  problem: "missing-file" | "missing-anchor";
}

/** Static-site generators whose root-relative links are routes, not repository paths. */
const SITE_CONFIG = /(^|\/)\.vitepress\/|(^|\/)(docusaurus\.config\.\w+|mkdocs[\w.-]*\.ya?ml|conf\.py|_config\.ya?ml|hugo\.(toml|ya?ml)|book\.toml|astro\.config\.\w+|zensical\.toml)$/;

export function hasDocsSite(paths: Iterable<string>): boolean {
  for (const p of paths) if (SITE_CONFIG.test(p)) return true;
  return false;
}

/** Resolve a relative link against its document and report missing files or anchors. */
export async function checkRelativeLink(
  link: DocLink,
  exists: (path: string) => boolean,
  existsDir: (path: string) => boolean,
  read: (path: string) => Promise<string | undefined>,
  docsSite = false,
): Promise<RelativeCheck | undefined> {
  const [rawPath = "", fragment] = link.target.split("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.split("?")[0]!);
  } catch {
    decoded = rawPath;
  }
  const rootRelative = decoded.startsWith("/");
  // Inside a generated docs site, root-relative links are routes we cannot verify statically.
  if (rootRelative && docsSite) return undefined;
  const base = rootRelative ? decoded.slice(1) : posix.join(dirname(link.path), decoded);
  const resolved = normalize(base).replace(/^(\.\.\/)+/, "").replace(/\/$/, "");
  let targetPath = decoded === "" ? link.path : resolved;
  if (decoded !== "" && !exists(targetPath) && !existsDir(targetPath)) {
    // Sites render .md as .html and directories as index pages.
    const alternates = [targetPath.replace(/\.html?$/, ".md"), targetPath.replace(/\.html?$/, ".mdx"), `${targetPath}/index.md`, `${targetPath}.md`, `${targetPath}/README.md`];
    const alt = alternates.find((a) => a !== targetPath && exists(a));
    if (!alt) return docsSite && /\.html?$|\/$/.test(decoded) ? undefined : { link, resolved: targetPath, problem: "missing-file" };
    targetPath = alt;
  }
  if (fragment && /\.(md|markdown|mdx)$/i.test(targetPath) && exists(targetPath)) {
    const text = await read(targetPath);
    // Emoji and punctuation render differently across slug implementations; compare the alphanumeric skeleton.
    const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const anchors = text === undefined ? new Set<string>() : anchorsIn(text);
    const wanted = bare(decodeURIComponent(fragment));
    const found = anchors.has(fragment.toLowerCase()) || anchors.has(fragment) || [...anchors].some((a) => bare(a) === wanted && wanted.length > 0);
    if (text !== undefined && !found) {
      return { link, resolved: `${targetPath}#${fragment}`, problem: "missing-anchor" };
    }
  }
  return undefined;
}

export type LinkStatus = "ok" | "broken" | "unknown";

/** HEAD then GET; only a confirmed 404/410 or a repeatable DNS failure counts as broken. */
export interface ProbeOptions {
  timeoutMs?: number;
  /** Resolves a host name to its addresses; replaced in tests. */
  lookup?: Lookup;
}

const MAX_REDIRECTS = 5;

/** Hosts whose answers prove nothing: they block automated clients, or serve the page only to browsers. */
function notVerifiable(url: string, host: string): string | undefined {
  if (BOT_HOSTILE.test(host)) return "host blocks automated checks";
  if (/github\.com$/i.test(host) && /\/(discussions|projects|wiki|security\/advisories)(\/|$)/.test(url)) return "GitHub page not served to automated clients";
  return undefined;
}

/** Only http(s) on standard ports to hosts that resolve to public addresses; everything else is left unchecked. */
async function admissible(url: string, lookupFn: Lookup): Promise<{ host: string } | { refused: string } | { unresolvable: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { refused: "not an http(s) URL" };
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return { refused: "non-standard port not checked" };
  if (parsed.username || parsed.password) return { refused: "URL with credentials not checked" };
  const where = await classifyHost(parsed.hostname, lookupFn);
  if (where === "unresolvable") return { unresolvable: parsed.hostname };
  if (where === "private") return { refused: "host does not resolve to a public address" };
  return { host: parsed.hostname };
}

export async function probeUrl(url: string, fetchImpl?: typeof fetch, options: ProbeOptions | number = {}): Promise<{ status: LinkStatus; detail: string }> {
  const opts: ProbeOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const lookup = opts.lookup ?? defaultLookup;
  let admitted = await admissible(url, lookup);
  // No such host: ask once more before calling it broken, as DNS hiccups happen.
  if ("unresolvable" in admitted) admitted = await admissible(url, lookup);
  if ("unresolvable" in admitted) return { status: "broken", detail: "host does not resolve" };
  if ("refused" in admitted) return { status: "unknown", detail: admitted.refused };
  const unverifiable = notVerifiable(url, admitted.host);
  if (unverifiable) return { status: "unknown", detail: unverifiable };
  // Redirects are followed by hand so every hop passes the same host check as the first URL.
  const attempt = async (method: "HEAD" | "GET"): Promise<number | "network" | "redirect-refused" | "not-public"> => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: { status: number; location: string | undefined };
      try {
        res = fetchImpl ? await viaFetch(fetchImpl, current, method, timeoutMs) : await requestStatus(current, method, timeoutMs, opts.lookup);
      } catch (error) {
        // The address resolved at connect time was not public: a changed DNS answer, refused before any byte was sent.
        if ((error as { code?: string }).code === "ENOTPUBLIC") return "not-public";
        return isDnsFailure(error) ? "network" : -1;
      }
      const location = res.location;
      if (!(res.status >= 300 && res.status < 400 && location)) return res.status;
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return res.status;
      }
      const hop = await admissible(next, lookup);
      if (!("host" in hop) || notVerifiable(next, hop.host)) return "redirect-refused";
      current = next;
    }
    return -1;
  };
  let status = await attempt("HEAD");
  if (status === "redirect-refused") return { status: "unknown", detail: "redirects to a host or port that is not checked" };
  if (status === "not-public") return { status: "unknown", detail: "host resolved to a non-public address when connecting" };
  if (status === -1 || status === 405 || status === 403 || status === 404 || status === 400 || status === 501 || status === 500) status = await attempt("GET");
  if (status === "network") {
    const again = await attempt("GET");
    return again === "network" ? { status: "broken", detail: "host does not resolve" } : { status: "unknown", detail: "intermittent network error" };
  }
  if (status === "redirect-refused") return { status: "unknown", detail: "redirects to a host or port that is not checked" };
  if (status === "not-public") return { status: "unknown", detail: "host resolved to a non-public address when connecting" };
  if (status === 404 || status === 410) return { status: "broken", detail: `HTTP ${status}` };
  if (status >= 200 && status < 400) return { status: "ok", detail: `HTTP ${status}` };
  return { status: "unknown", detail: status === -1 ? "timeout or connection error" : `HTTP ${status}` };
}

function isDnsFailure(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return code === "ENOTFOUND" || code === "EAI_AGAIN";
}

/** An injected fetch (tests, or a caller with its own transport), with the same no-follow, no-body behaviour. */
async function viaFetch(fetchImpl: typeof fetch, url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<{ status: number; location: string | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, redirect: "manual", signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; gitgoblin-intel link check)", accept: "*/*" } });
    if (res.body) await res.body.cancel().catch(() => undefined);
    return { status: res.status, location: res.headers.get("location") ?? undefined };
  } finally {
    clearTimeout(timer);
  }
}

const TEMPLATE = /(^|\/)(pull_request_template|issue_template|ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/|DISCUSSION_TEMPLATE\/)/i;
const DOC_PREDICATE = (p: string) =>
  !TEMPLATE.test(p) &&
  (/^(readme|contributing|install|installation|usage|faq|docs?\/.*|\.github\/[^/]*)\.(md|markdown|mdx|rst)$/i.test(p) ||
    (/^[^/]+\.(md|rst)$/i.test(p) && !/^(changelog|changes|history|news|release|releases|authors|contributors)/i.test(p)));

export const linksAnalyzer: Analyzer = {
  name: "links",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    const links: DocLink[] = [];
    // Sphinx projects (Django among them) keep reStructuredText sources as .txt under docs/.
    const sphinxTxt = ctx.inventory.files.some((f) => /^docs?\/conf\.py$/.test(f.path));
    const predicate = (p: string) => DOC_PREDICATE(p) || (sphinxTxt && /^docs?\/.*\.txt$/.test(p));
    for await (const { path, text } of textFiles(ctx, predicate, 60)) links.push(...extractLinks(path, text));
    if (links.length === 0) return [];

    const exists = (p: string) => ctx.inventory.byPath.has(p);
    const dirs = new Set<string>();
    for (const f of ctx.inventory.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    const existsDir = (p: string) => dirs.has(p);
    const docsSite = hasDocsSite(ctx.inventory.files.map((f) => f.path));

    const findings: Finding[] = [];
    const relative = links.filter((l) => !isExternal(l.target));
    const generated = new Map<string, boolean>();
    const MAX_GENERATED_GREPS = 25;
    let generatedGreps = 0;
    for (const link of relative) {
      const check = await checkRelativeLink(link, exists, existsDir, (p) => ctx.read(p), docsSite && link.path.includes("/"));
      if (!check) continue;
      if (check.problem === "missing-file" && docsSite) {
        // A whole directory absent from the repository (ruff's docs/rules/) is generated at build time.
        const parent = check.resolved.split("/").slice(0, -1).join("/");
        if (parent && !existsDir(parent)) continue;
        // So is a page whose name appears in build scripts or site config (ruff's settings.md).
        const base = check.resolved.split("/").pop()!;
        if (!generated.has(base) && generatedGreps >= MAX_GENERATED_GREPS) {
          if (generatedGreps === MAX_GENERATED_GREPS) ctx.budget.cut(`stopped checking whether missing docs pages are generated after ${MAX_GENERATED_GREPS} lookups`);
          generatedGreps++;
          continue;
        }
        if (!generated.has(base)) generatedGreps++;
        if (!generated.has(base)) generated.set(base, (await ctx.repo.grep(base, [":(glob)**/*.py", ":(glob)**/*.ts", ":(glob)**/*.js", ":(glob)**/*.mjs", ":(glob)**/*.rs", ":(glob)**/*.yml", ":(glob)**/*.yaml", ":(glob)**/*.toml", ":(glob)**/*.json", ":(glob)**/Makefile"])).length > 0);
        if (generated.get(base)) continue;
      }
      const isReadme = /^readme/i.test(link.path);
      findings.push({
        kind: "broken_link",
        clusterKey: "relative",
        title: "Fix links to files that no longer exist in the repository",
        summary: "Relative links in the documentation point at files or headings that are not in the repository, so readers land on 404 pages.",
        evidence: [evidence(ctx, "file", `${link.path}:${link.line}`, { excerpt: `${link.text ? `[${link.text}]` : ""}(${link.target})`, note: check.problem === "missing-file" ? `no file or directory at ${check.resolved}` : `no heading matching #${link.target.split("#")[1]} in ${check.resolved.split("#")[0]}` })],
        files: [link.path],
        effort: "trivial",
        skills: ["docs"],
        approach: ["Find where each target moved with git log --follow or by searching for the heading text.", "Point the link at the new location, or remove it if the content is gone.", "Open one PR for all link fixes in the repository."],
        acceptanceCriteria: ["Every relative link in the touched documents resolves to a file or heading that exists."],
        risks: ["Documentation-only PRs are sometimes deprioritised; bundling all link fixes into one PR helps."],
        signals: {
          value: isReadme ? 0.5 : 0.4,
          valueReason: isReadme ? "broken navigation in the README, the first thing visitors read" : "broken navigation inside the docs",
          feasibility: 0.95,
          feasibilityReason: "targets are findable in git history",
          confidence: check.problem === "missing-file" ? 0.95 : 0.8,
          confidenceReason: check.problem === "missing-file" ? "the path is absent from the checkout" : "no heading produced that anchor (custom anchors could exist)",
          welcomenessFactor: 0.85,
        },
      });
    }

    if (!ctx.options.checkLinks) {
      ctx.budget.note("external link checks disabled");
      return findings;
    }
    const external = new Map<string, DocLink[]>();
    for (const l of links.filter((l) => isExternal(l.target))) external.set(l.target, [...(external.get(l.target) ?? []), l]);
    const urls = [...external.keys()].slice(0, 150);
    if (external.size > urls.length) ctx.budget.cut(`checked ${urls.length} of ${external.size} external links`);
    // Without an injected fetch, probes go through node:http(s) with a lookup that only connects to public addresses.
    const results = await mapLimit(urls, 8, async (url) => ({ url, result: await probeUrl(url, ctx.options.fetchImpl) }));
    ctx.budget.httpChecks += urls.length;
    for (const { url, result } of results) {
      if (result.status !== "broken") continue;
      const first = external.get(url)![0]!;
      findings.push({
        kind: "broken_link",
        clusterKey: "external",
        title: "Fix dead external links in the documentation",
        summary: "External links in the documentation return 404/410 or point at hosts that no longer exist.",
        evidence: [evidence(ctx, "http", url, { excerpt: `${first.path}:${first.line} ${first.text ? `[${first.text}]` : ""}`, note: result.detail })],
        files: [first.path],
        effort: "trivial",
        skills: ["docs"],
        approach: ["Find the current location of each resource (project moved, docs reorganised) or an archived copy on web.archive.org.", "Replace or remove the link; do not leave archive links where a live page exists.", "Bundle every fix into a single PR."],
        acceptanceCriteria: ["All touched links return 2xx when followed in a browser."],
        risks: ["Some sites block non-browser clients; re-check each URL manually before changing it.", "Documentation-only PRs are sometimes deprioritised."],
        signals: {
          value: 0.4,
          valueReason: "dead links send readers nowhere; cheap to fix in bulk",
          feasibility: 0.95,
          feasibilityReason: "replacements are usually one search away",
          confidence: 0.85,
          confidenceReason: `confirmed over HTTP (${result.detail}) with a browser-like user agent`,
          welcomenessFactor: 0.8,
        },
      });
    }
    void profile;
    return findings;
  },
};
