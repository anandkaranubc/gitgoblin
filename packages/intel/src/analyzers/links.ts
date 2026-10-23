import { dirname, normalize, posix } from "node:path";

import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { mapLimit } from "../util/limit.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";
import { type Lookup, defaultLookup, resolvesToPublicAddress } from "../util/net.ts";

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
  const rst = path.toLowerCase().endsWith(".rst");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^ {4,}\S/.test(line) && !/^\s*[-*]|^\s*\d+\./.test(lines[i - 1] ?? "")) continue;
    const push = (target: string, label: string) => {
      const t = target.trim().replace(/[.,;:!?)]+$/, "");
      if (!t || SKIP_URL.test(t) || BADGE_HOST.test(t)) return;
      links.push({ path, line: i + 1, target: t, text: label.trim() });
    };
    if (rst) {
      for (const m of line.matchAll(/`([^`<]*)<([^>]+)>`_/g)) push(m[2]!, m[1]!);
      for (const m of line.matchAll(/^\.\. _[^:]+:\s*(\S+)/g)) push(m[1]!, "");
      continue;
    }
    // Images are badges and screenshots; their rot is low value and often blocked for bots.
    const withoutImages = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img[^>]*>/gi, "");
    for (const m of withoutImages.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) push(m[2]!, m[1]!);
    for (const m of withoutImages.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/g)) push(m[2]!, m[1]!);
    for (const m of withoutImages.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) push(m[1]!, "");
    for (const m of withoutImages.matchAll(/<(https?:\/\/[^>\s]+)>/g)) push(m[1]!, "");
    // Bare URLs not already inside a markdown link.
    const stripped = withoutImages.replace(/\]\([^)]*\)/g, "]()").replace(/\]:\s*\S+/g, "]:").replace(/href=["'][^"']*["']/gi, "");
    for (const m of stripped.matchAll(/(?<![("'<\w])https?:\/\/[^\s<>"')\]]+/g)) push(m[0], "");
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
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/ /g, "-");
}

export function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) {
      const base = slugify(heading.replace(/\s*\{#[^}]+\}\s*$/, ""));
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
      const explicit = /\{#([^}]+)\}/.exec(heading)?.[1];
      if (explicit) anchors.add(explicit);
    }
    // Any tag may carry an id or name anchor, e.g. ripgrep's <h3 name="complete">.
    for (const m of line.matchAll(/<\w+\s[^>]*?\b(?:name|id)=["']([^"']+)["']/gi)) anchors.add(m[1]!);
  }
  return anchors;
}

export interface RelativeCheck {
  link: DocLink;
  resolved: string;
  problem: "missing-file" | "missing-anchor";
}

/** Resolve a relative link against its document and report missing files or anchors. */
export async function checkRelativeLink(
  link: DocLink,
  exists: (path: string) => boolean,
  existsDir: (path: string) => boolean,
  read: (path: string) => Promise<string | undefined>,
): Promise<RelativeCheck | undefined> {
  const [rawPath = "", fragment] = link.target.split("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.split("?")[0]!);
  } catch {
    decoded = rawPath;
  }
  const base = decoded.startsWith("/") ? decoded.slice(1) : posix.join(dirname(link.path), decoded);
  const resolved = normalize(base).replace(/^(\.\.\/)+/, "").replace(/\/$/, "");
  const targetPath = decoded === "" ? link.path : resolved;
  if (decoded !== "" && !exists(targetPath) && !existsDir(targetPath)) return { link, resolved: targetPath, problem: "missing-file" };
  if (fragment && /\.(md|markdown|mdx)$/i.test(targetPath) && exists(targetPath)) {
    const text = await read(targetPath);
    if (text !== undefined && !anchorsIn(text).has(fragment.toLowerCase()) && !anchorsIn(text).has(fragment)) {
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

/** Hosts whose answers prove nothing: they block automated clients. */
function notVerifiable(host: string): string | undefined {
  return BOT_HOSTILE.test(host) ? "host blocks automated checks" : undefined;
}

/** Only http(s) on standard ports to hosts that resolve to public addresses; everything else is left unchecked. */
async function admissible(url: string, lookupFn: Lookup): Promise<{ host: string } | { refused: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { refused: "not an http(s) URL" };
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return { refused: "non-standard port not checked" };
  if (parsed.username || parsed.password) return { refused: "URL with credentials not checked" };
  if (!(await resolvesToPublicAddress(parsed.hostname, lookupFn))) return { refused: "host does not resolve to a public address" };
  return { host: parsed.hostname };
}

/** HEAD then GET; only a confirmed 404/410 or a repeatable DNS failure counts as broken. Never contacts private addresses. */
export async function probeUrl(url: string, fetchImpl: typeof fetch, options: ProbeOptions | number = {}): Promise<{ status: LinkStatus; detail: string }> {
  const { timeoutMs = 8000, lookup = defaultLookup } = typeof options === "number" ? { timeoutMs: options } : options;
  const admitted = await admissible(url, lookup);
  if ("refused" in admitted) return { status: "unknown", detail: admitted.refused };
  const unverifiable = notVerifiable(admitted.host);
  if (unverifiable) return { status: "unknown", detail: unverifiable };
  // Redirects are followed by hand so every hop passes the same checks as the first URL.
  const attempt = async (method: "HEAD" | "GET"): Promise<number | "network" | "redirect-refused"> => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(current, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "Mozilla/5.0 (compatible; gitgoblin-intel link check)", accept: "*/*" },
        });
      } catch (error) {
        return isDnsFailure(error) ? "network" : -1;
      } finally {
        clearTimeout(timer);
      }
      if (res.body) await res.body.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!(res.status >= 300 && res.status < 400 && location)) return res.status;
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return res.status;
      }
      const hop = await admissible(next, lookup);
      if ("refused" in hop || notVerifiable(hop.host)) return "redirect-refused";
      current = next;
    }
    return -1;
  };
  let status = await attempt("HEAD");
  if (status === "redirect-refused") return { status: "unknown", detail: "redirects to a host or port that is not checked" };
  if (status === -1 || status === 405 || status === 403 || status === 404 || status === 400 || status === 501 || status === 500) status = await attempt("GET");
  if (status === "network") {
    const again = await attempt("GET");
    return again === "network" ? { status: "broken", detail: "host does not resolve" } : { status: "unknown", detail: "intermittent network error" };
  }
  if (status === "redirect-refused") return { status: "unknown", detail: "redirects to a host or port that is not checked" };
  if (status === 404 || status === 410) return { status: "broken", detail: `HTTP ${status}` };
  if (status >= 200 && status < 400) return { status: "ok", detail: `HTTP ${status}` };
  return { status: "unknown", detail: status === -1 ? "timeout or connection error" : `HTTP ${status}` };
}

function isDnsFailure(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN";
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
    for await (const { path, text } of textFiles(ctx, DOC_PREDICATE, 60)) links.push(...extractLinks(path, text));
    if (links.length === 0) return [];

    const exists = (p: string) => ctx.inventory.byPath.has(p);
    const dirs = new Set<string>();
    for (const f of ctx.inventory.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    const existsDir = (p: string) => dirs.has(p);

    const findings: Finding[] = [];
    const relative = links.filter((l) => !isExternal(l.target));
    for (const link of relative) {
      const check = await checkRelativeLink(link, exists, existsDir, (p) => ctx.read(p));
      if (!check) continue;
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
    const fetchImpl = ctx.options.fetchImpl ?? fetch;
    const results = await mapLimit(urls, 8, async (url) => ({ url, result: await probeUrl(url, fetchImpl) }));
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
