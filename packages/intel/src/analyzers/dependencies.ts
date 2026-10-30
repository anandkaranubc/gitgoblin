import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { mapLimit } from "../util/limit.ts";
import { truncate } from "../util/text.ts";
import { type LockedPackage, dedupePackages, parseLockfile } from "./lockfiles.ts";
import type { PrSample } from "../github/types.ts";
import { type Analyzer, type Finding, evidence } from "./types.ts";

const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.mod)$/;
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";

export interface Vulnerability {
  id: string;
  aliases: string[];
  summary: string;
  severity: "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";
  fixed: string | undefined;
}

interface OsvBatchResponse { results: { vulns?: { id: string }[] }[] }
interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: { package?: { name: string; ecosystem: string }; ranges?: { type: string; events: { introduced?: string; fixed?: string }[] }[]; database_specific?: { severity?: string } }[];
}

export function severityOf(v: OsvVuln, pkg: LockedPackage): Vulnerability["severity"] {
  const raw = (v.database_specific?.severity ?? v.affected?.find((a) => a.package?.name.toLowerCase() === pkg.name.toLowerCase())?.database_specific?.severity ?? "").toUpperCase();
  if (raw === "CRITICAL" || raw === "HIGH" || raw === "MODERATE" || raw === "LOW") return raw;
  if (raw === "MEDIUM") return "MODERATE";
  const cvss = v.severity?.find((s) => /^CVSS/.test(s.type))?.score;
  if (cvss) {
    const av = /AV:(\w)/.exec(cvss)?.[1];
    const impact = (cvss.match(/[CIA]:H/g) ?? []).length;
    if (av === "N" && impact >= 2) return "HIGH";
    if (impact >= 1) return "MODERATE";
    return "LOW";
  }
  return "UNKNOWN";
}

/** The fix on the locked version's own release line: the lowest fixed version above it (4.2.5 gets 4.2.15, not 5.0.8). */
export function fixedVersion(v: OsvVuln, pkg: LockedPackage): string | undefined {
  const affected = v.affected?.filter((a) => a.package?.ecosystem === pkg.ecosystem && a.package.name.toLowerCase() === pkg.name.toLowerCase()) ?? [];
  const fixes = affected.flatMap((a) => a.ranges ?? []).filter((r) => r.type !== "GIT").flatMap((r) => r.events.map((e) => e.fixed));
  return fixes.filter((f): f is string => f !== undefined && compareVersionNumbers(f, pkg.version) > 0).sort(compareVersionNumbers)[0];
}

/** Dotted versions compared number by number (4.2.15 after 4.2.9); pre-release and build suffixes are ignored. */
export function compareVersionNumbers(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const RANK: Record<Vulnerability["severity"], number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, UNKNOWN: 1.5 };

/** An open pull request whose title names the package (a Dependabot or Renovate bump, or a person's): the work is in flight. */
export function openPrFor(prs: PrSample[], name: string): PrSample | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[\\s"'\`(\\[])${escaped}($|[\\s"'\`)\\],:@])`, "i");
  return prs.find((p) => p.state === "OPEN" && named.test(p.title));
}

/** Mark a finding as already handled by an open PR, so the evaluator skips it and says why. */
function inFlight(ctx: AnalysisContext, finding: Finding, pr: PrSample): Finding {
  const who = pr.author?.isBot ? `${pr.author.login.replace(/\[bot\]$/, "")} PR` : "Open PR";
  finding.signals.novelty = 0.05;
  finding.signals.noveltyReason = `${who} #${pr.number} already updates it ("${truncate(pr.title, 80)}"); review that instead`;
  finding.evidence.push(evidence(ctx, "pull_request", pr.url, { excerpt: pr.title, note: `open${pr.isDraft ? " draft" : ""} PR by ${pr.author?.login ?? "unknown"}` }));
  return finding;
}

export const dependenciesAnalyzer: Analyzer = {
  name: "dependencies",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (!ctx.options.dependencyChecks) {
      ctx.budget.note("dependency checks disabled");
      return [];
    }
    const fetchImpl = ctx.options.fetchImpl ?? fetch;
    const findings: Finding[] = [];
    const packages: LockedPackage[] = [];
    const lockPaths = ctx.inventory.files.filter((f) => !f.vendored && LOCKFILES.test(f.path) && f.path.split("/").length <= 3).map((f) => f.path).slice(0, 6);
    for (const path of lockPaths) {
      const text = await ctx.read(path, 8 * 1024 * 1024);
      if (text) packages.push(...parseLockfile(path, text));
    }
    for (const d of ctx.manifests.python?.dependencies ?? []) if (d.pinned && d.version) packages.push({ ecosystem: "PyPI", name: d.name, version: d.version, dev: d.dev, source: ctx.manifests.python?.paths[0] ?? "pyproject.toml" });
    const unique = dedupePackages(packages).filter((p) => !/^(\.|file:|link:|workspace:)/.test(p.version) && /^\d/.test(p.version));
    if (unique.length === 0) return findings;
    const capped = unique.slice(0, 1500);
    if (unique.length > capped.length) ctx.budget.cut(`queried OSV for ${capped.length} of ${unique.length} locked packages`);

    const direct = new Set([
      ...(ctx.manifests.node?.dependencies.map((d) => d.name) ?? []),
      ...(ctx.manifests.python?.dependencies.map((d) => d.name) ?? []),
      ...(ctx.manifests.go?.dependencies.filter((d) => !d.dev).map((d) => d.name) ?? []),
      ...(ctx.manifests.rust?.dependencies.map((d) => d.name) ?? []),
    ]);

    // OSV: one batch call per 1000 packages, then details for the worst few.
    const vulnIdsByPkg = new Map<LockedPackage, string[]>();
    for (let i = 0; i < capped.length; i += 1000) {
      const chunk = capped.slice(i, i + 1000);
      try {
        const res = await fetchImpl(OSV_BATCH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }),
          signal: AbortSignal.timeout(20_000),
        });
        ctx.budget.httpChecks++;
        if (!res.ok) {
          ctx.budget.note(`OSV returned ${res.status}; vulnerability check skipped`);
          break;
        }
        const data = (await res.json()) as OsvBatchResponse;
        data.results.forEach((r, idx) => {
          if (r.vulns?.length) vulnIdsByPkg.set(chunk[idx]!, r.vulns.map((v) => v.id));
        });
      } catch (error) {
        ctx.budget.note(`OSV query failed: ${(error as Error).message}`);
        break;
      }
    }

    const affected = [...vulnIdsByPkg.entries()].sort((a, b) => Number(direct.has(b[0].name)) - Number(direct.has(a[0].name)) || b[1].length - a[1].length).slice(0, 10);
    let detailBudget = 20;
    for (const [pkg, ids] of affected) {
      const details: Vulnerability[] = [];
      for (const id of ids.slice(0, Math.min(3, detailBudget))) {
        try {
          const res = await fetchImpl(`${OSV_VULN}${id}`, { signal: AbortSignal.timeout(10_000) });
          ctx.budget.httpChecks++;
          detailBudget--;
          if (!res.ok) continue;
          const v = (await res.json()) as OsvVuln;
          details.push({ id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? truncate(v.details ?? "", 120), severity: severityOf(v, pkg), fixed: fixedVersion(v, pkg) });
        } catch {
          // Leave the id without details.
        }
      }
      const worst = details.reduce<Vulnerability["severity"]>((acc, d) => (RANK[d.severity] > RANK[acc] ? d.severity : acc), "UNKNOWN");
      const isDirect = direct.has(pkg.name);
      // A library's lockfile pins its development environment, not what users install.
      const runtimeDeps = new Set([...(ctx.manifests.python?.dependencies ?? []), ...(ctx.manifests.node?.dependencies ?? []), ...(ctx.manifests.rust?.dependencies ?? [])].filter((d) => !d.dev).map((d) => d.name));
      if (["library", "framework", "plugin"].includes(profile.nature) && !runtimeDeps.has(pkg.name) && pkg.ecosystem !== "Go") pkg.dev = true;
      const fixed = details.map((d) => d.fixed).filter((f): f is string => Boolean(f)).sort(compareVersionNumbers).pop();
      const bot = profile.welcomeness.rules.dependencyBot;
      findings.push({
        kind: "dependency",
        clusterKey: `vuln:${pkg.ecosystem}:${pkg.name}`,
        title: `Update ${pkg.name} ${pkg.version}: ${ids.length} known ${ids.length === 1 ? "vulnerability" : "vulnerabilities"}${worst !== "UNKNOWN" ? ` (${worst.toLowerCase()})` : ""}`,
        summary: `${pkg.name}@${pkg.version} is listed in the ${pkg.ecosystem} lockfile and OSV reports ${ids.length} advisor${ids.length === 1 ? "y" : "ies"} for it${fixed ? `; fixed in ${fixed}` : ""}. ${isDirect ? "It is a direct dependency." : "It is pulled in transitively."}${pkg.dev ? " It is only used in development." : ""}`,
        evidence: [
          evidence(ctx, "file", pkg.source ?? "lockfile", { note: `${pkg.name}@${pkg.version}${pkg.dev ? " (dev)" : ""}` }),
          ...details.map((d) => evidence(ctx, "http", `https://osv.dev/vulnerability/${d.id}`, { excerpt: d.summary, note: `${d.severity.toLowerCase()}${d.aliases.length ? `; ${d.aliases.slice(0, 2).join(", ")}` : ""}${d.fixed ? `; fixed in ${d.fixed}` : ""}` })),
          ...ids.slice(details.length, 6).map((id) => evidence(ctx, "http", `https://osv.dev/vulnerability/${id}`, { note: "details not fetched (budget)" })),
        ],
        files: pkg.source ? [pkg.source] : lockPaths,
        effort: isDirect ? "small" : "small",
        skills: [pkg.ecosystem === "PyPI" ? "python" : pkg.ecosystem === "npm" ? "node" : pkg.ecosystem === "crates.io" ? "rust" : pkg.ecosystem.toLowerCase()],
        approach: [
          isDirect ? `Bump ${pkg.name} to ${fixed ?? "the latest patched release"} in the manifest and refresh the lockfile.` : `Refresh the lockfile so ${pkg.name} resolves to ${fixed ?? "a patched release"}; if a parent pins it, bump the parent.`,
          "Run the test suite; read the advisory to see whether the project's usage is affected and say so in the PR.",
          "Link the OSV or GHSA ids in the PR description.",
        ],
        acceptanceCriteria: [`The lockfile resolves ${pkg.name} to a version with no open advisories.`, "Tests pass."],
        etiquette: bot ? ["Check Dependabot or Renovate PRs first; if one exists, review or nudge it instead of opening a duplicate."] : [],
        risks: [...(bot ? ["A dependency bot is configured; a PR may already exist."] : []), ...(fixed ? [] : ["No fixed version is published yet; the PR may need to document mitigation instead."]), ...(pkg.dev ? ["Development-only dependency: lower urgency."] : [])],
        signals: {
          value: Math.min(0.9, (worst === "CRITICAL" ? 0.9 : worst === "HIGH" ? 0.8 : worst === "MODERATE" ? 0.6 : 0.5) * (pkg.dev ? 0.7 : 1)),
          valueReason: `${worst.toLowerCase()} severity${pkg.dev ? ", dev-only" : ""}${isDirect ? ", direct dependency" : ", transitive"}`,
          feasibility: isDirect ? 0.9 : 0.65,
          feasibilityReason: isDirect ? "manifest bump plus lockfile refresh" : "transitive: may need a parent bump or an override",
          confidence: 0.9,
          confidenceReason: "exact locked version matched against OSV",
          welcomenessFactor: bot ? 0.45 : 0.9,
          welcomenessReason: bot ? "a dependency bot already handles bumps here" : undefined,
        },
      });
      const pr = openPrFor(ctx.samples?.openPrs ?? [], pkg.name);
      if (pr) inFlight(ctx, findings[findings.length - 1]!, pr);
    }

    // Direct npm dependencies whose latest release is marked deprecated on the registry.
    const node = ctx.manifests.node;
    if (node) {
      const names = node.dependencies.filter((d) => !d.name.startsWith("@types/")).slice(0, 40);
      if (node.dependencies.length > names.length) ctx.budget.cut(`checked npm deprecation for ${names.length} of ${node.dependencies.length} dependencies`);
      const results = await mapLimit(names, 6, async (dep) => {
        try {
          const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(dep.name).replace("%40", "@")}/latest`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
          ctx.budget.httpChecks++;
          if (!res.ok) return undefined;
          const data = (await res.json()) as { version?: string; deprecated?: string };
          return data.deprecated ? { dep, message: data.deprecated, version: data.version } : undefined;
        } catch {
          return undefined;
        }
      });
      for (const r of results) {
        if (!r) continue;
        findings.push({
          kind: "dependency",
          clusterKey: `npm-deprecated:${r.dep.name}`,
          title: `Replace ${r.dep.name}, deprecated on npm`,
          summary: `The npm registry marks the latest release of ${r.dep.name} as deprecated: "${truncate(r.message, 160)}"`,
          evidence: [evidence(ctx, "http", `https://www.npmjs.com/package/${r.dep.name}`, { excerpt: truncate(r.message, 200), note: `registry deprecation notice on ${r.dep.name}@${r.version ?? "latest"}` }), evidence(ctx, "file", "package.json", { note: `${r.dep.dev ? "dev " : ""}dependency ${r.dep.name} ${r.dep.version ?? ""}` })],
          files: ["package.json"],
          effort: r.dep.dev ? "small" : "medium",
          skills: ["node"],
          approach: ["Follow the replacement named in the deprecation notice.", "Port call sites and run the tests.", "Keep the PR focused on this one package."],
          acceptanceCriteria: [`${r.dep.name} is gone from package.json and the lockfile; tests pass.`],
          risks: ["Replacement libraries can differ subtly in behaviour."],
          signals: { value: r.dep.dev ? 0.35 : 0.5, valueReason: "upstream says stop using it; no more fixes will come", feasibility: 0.7, feasibilityReason: "deprecation notices usually name the replacement", confidence: 0.95, confidenceReason: "deprecation flag read from the npm registry", welcomenessFactor: 0.85 },
        });
        const pr = openPrFor(ctx.samples?.openPrs ?? [], r.dep.name);
        if (pr) inFlight(ctx, findings[findings.length - 1]!, pr);
      }
    }
    return findings;
  },
};
