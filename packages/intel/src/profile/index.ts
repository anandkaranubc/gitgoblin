import type { CiInfo, Language, RepositoryProfile, Structure } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { computeActivity, hotFiles } from "./activity.ts";
import { inferConventions } from "./conventions.ts";
import { describeEcosystems } from "./ecosystems.ts";
import { centralFiles } from "./imports.ts";
import { LICENSE_FILE, licenseFromText } from "./license.ts";
import { classifyNature } from "./nature.ts";
import { assessWelcomeness } from "./welcomeness.ts";

const INSTRUCTION_FILES = /^(CLAUDE\.md|AGENTS\.md|\.cursorrules|\.cursor\/rules\/.*|\.github\/copilot-instructions\.md|GEMINI\.md|\.windsurfrules|\.clinerules)$/;

export async function buildProfile(ctx: AnalysisContext): Promise<RepositoryProfile> {
  const { meta, inventory, manifests } = ctx;
  const readmePath = inventory.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))?.path;
  const readme = readmePath ? await ctx.read(readmePath) : undefined;
  const contributingPath = inventory.files.find((f) => /^(\.github\/|docs?\/)?contributing(\.\w+)?$/i.test(f.path))?.path;
  const contributing = contributingPath ? await ctx.read(contributingPath) : undefined;
  const prTemplatePath = inventory.files.find((f) => /pull_request_template(\.\w+)?$/i.test(f.path))?.path;
  const prTemplate = prTemplatePath ? await ctx.read(prTemplatePath) : undefined;

  const workflows = inventory.files.filter((f) => f.path.startsWith(".github/workflows/") && /\.ya?ml$/.test(f.path)).map((f) => f.path);
  const ciRunLines: string[] = [];
  for (const wf of workflows.slice(0, 10)) {
    const text = await ctx.read(wf);
    if (!text) continue;
    for (const line of text.split("\n")) {
      const m = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
      if (m && m[1] && !m[1].startsWith("|") && !m[1].startsWith(">")) ciRunLines.push(m[1]);
    }
  }

  const { nature, reason } = classifyNature({ meta, inventory, manifests, readme });
  const ecosystems = describeEcosystems(manifests, inventory, ciRunLines);
  const activity = computeActivity({
    commits: ctx.commits,
    samples: ctx.samples,
    releases: ctx.releases,
    pushedAt: meta.pushedAt,
    openIssues: ctx.samples?.openIssueCount ?? Math.max(0, meta.openIssuesAndPrs - (ctx.samples?.openPrCount ?? 0)),
    openPrs: ctx.samples?.openPrCount ?? 0,
    now: ctx.now,
  });
  const welcomeness = assessWelcomeness({ meta, samples: ctx.samples, activity, inventory, docs: { contributing, readme, prTemplate }, now: ctx.now });
  const conventions = inferConventions(ctx.commits, ctx.samples, ecosystems);

  const totalBytes = Object.values(ctx.languages).reduce((a, b) => a + b, 0);
  const languages: Language[] = Object.entries(ctx.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({ name, bytes, share: totalBytes ? Math.round((bytes / totalBytes) * 1000) / 1000 : 0 }));

  const ci: CiInfo = {
    provider: workflows.length ? "github_actions" : inventory.files.some((f) => f.category === "ci") ? "other" : "none",
    workflows: workflows.length ? workflows : inventory.files.filter((f) => f.category === "ci").map((f) => f.path).slice(0, 10),
  };
  const lastRun = ctx.runs.find((r) => r.event === "push") ?? ctx.runs[0];
  if (lastRun?.conclusion) ci.lastRunConclusion = lastRun.conclusion;
  if (lastRun) ci.lastRunAt = lastRun.updatedAt;

  const central = await centralFiles(inventory, (p, max) => ctx.read(p, max), manifests.go?.module);
  if (central.truncated) ctx.budget.cut("import graph built from the first 3000 source files");

  const notes: string[] = [];
  if (!ctx.samples && !ctx.budget.notes.some((n) => n.startsWith("issue and PR sampling skipped"))) notes.push("Issue and pull request samples unavailable (no GitHub token or GraphQL failed); welcomeness uses git and metadata only.");
  if (inventory.truncated) notes.push(`Only ${inventory.files.length} of ${inventory.totalCount} files were inventoried.`);
  if (meta.isFork) notes.push("This is a fork; contributions usually belong upstream.");
  if (!meta.hasIssues && ctx.ref.host === "github.com") notes.push("GitHub issues are disabled; the project tracks work elsewhere (see its contributing guide), so issue-based opportunities are not available here.");
  if (ctx.ref.host !== "github.com") notes.push(ctx.samples ? `Hosted on ${ctx.ref.host}: issues and merge requests come from its public API without authentication, so maintainer status is inferred from who merges and closes${ctx.runs.length ? "" : "; CI runs were not read"}.` : `Hosted on ${ctx.ref.host}: issues, pull requests and CI runs were not read, so welcomeness reflects git activity and documentation only.`);

  const profile: RepositoryProfile = {
    repo: ctx.ref,
    analyzedAt: ctx.nowIso,
    headSha: await ctx.repo.headSha(),
    defaultBranch: meta.defaultBranch,
    topics: meta.topics,
    stars: meta.stars,
    forks: meta.forks,
    archived: meta.archived,
    isFork: meta.isFork,
    nature,
    natureReason: reason,
    languages,
    ecosystems,
    ci,
    structure: { ...describeStructure(inventory, manifests), centralFiles: central.files },
    activity,
    welcomeness,
    conventions,
    hotFiles: hotFiles(ctx.commits, inventory),
    instructionFiles: inventory.files.filter((f) => INSTRUCTION_FILES.test(f.path)).map((f) => f.path),
    notes,
  };
  if (meta.description) profile.description = meta.description;
  if (meta.homepage) profile.homepage = meta.homepage;
  const license = meta.license ?? (await licenseFromFiles(ctx));
  if (license) profile.license = license;
  return profile;
}

/** Read the license file when no API said what the license is (other forges, or GitHub's detector giving up). */
async function licenseFromFiles(ctx: AnalysisContext): Promise<string | undefined> {
  const files = ctx.inventory.files.filter((f) => LICENSE_FILE.test(f.path)).map((f) => f.path);
  const canonical = files.filter((p) => /^(LICENSE|LICENCE|COPYING|UNLICENSE)(\.(md|txt|rst))?$/i.test(p));
  const found: string[] = [];
  for (const path of [...canonical, ...files.filter((p) => !canonical.includes(p))].slice(0, 6)) {
    const text = await ctx.read(path, 64 * 1024);
    const id = text ? licenseFromText(text) : undefined;
    if (id && canonical.includes(path)) return id;
    if (id) found.push(id);
  }
  if (found.length <= 1) return found[0];
  // Several COPYING.* variants (Eigen: MPL2, APACHE, BSD...): the README says which one is primary.
  const readmePath = ctx.inventory.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))?.path;
  const readme = readmePath ? (await ctx.read(readmePath, 20 * 1024)) ?? "" : "";
  return found.find((id) => new RegExp(id.split("-")[0]!.replace("MPL", "(MPL|Mozilla)").replace("GPL", "GPL"), "i").test(readme.slice(0, 5000))) ?? found[0];
}

function describeStructure(inventory: AnalysisContext["inventory"], manifests: AnalysisContext["manifests"]): Omit<Structure, "centralFiles"> {
  const live = inventory.files.filter((f) => !f.vendored);
  const topDirs = (predicate: (p: string) => boolean) => {
    const counts = new Map<string, number>();
    for (const f of live) {
      if (!predicate(f.path) || !f.path.includes("/")) continue;
      const dir = f.path.split("/").slice(0, f.path.startsWith("src/") || f.path.startsWith("lib/") ? 2 : 1).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d);
  };
  const entryPoints = new Set<string>();
  for (const p of ["main.py", "app.py", "cli.py", "__main__.py", "main.go", "src/main.rs", "src/lib.rs", "index.js", "index.ts", "src/index.ts", "src/index.js", "src/cli.ts", "bin/cli.js", "manage.py"]) {
    if (inventory.byPath.has(p)) entryPoints.add(p);
  }
  for (const dir of manifests.python?.packageDirs ?? []) for (const f of ["__main__.py", "cli.py", "main.py"]) if (inventory.byPath.has(`${dir}/${f}`)) entryPoints.add(`${dir}/${f}`);
  for (const f of live) if (/^cmd\/[^/]+\/main\.go$/.test(f.path)) entryPoints.add(f.path);
  return {
    fileCount: inventory.totalCount,
    analyzedFileCount: live.length,
    sourceDirs: topDirs((p) => inventory.byPath.get(p)?.category === "source"),
    testDirs: topDirs((p) => inventory.byPath.get(p)?.category === "test"),
    docsDirs: topDirs((p) => inventory.byPath.get(p)?.category === "docs"),
    entryPoints: [...entryPoints].slice(0, 10),
  };
}
