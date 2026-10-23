#!/usr/bin/env node
/**
 * Did maintainers act on what the code analyzers flag?
 *
 * Analyze each repository at the commit from N days ago (clone-based analyzers
 * only, clock at that commit), then check today's HEAD: is the flagged line,
 * rule match, dead link or missing file gone? A resolution rate well above
 * ordinary code churn means the findings point at things people fix.
 *
 * Usage: node scripts/backtest-code.ts owner/name [owner/name...] [--days 180]
 */
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { promisify } from "node:util";

import { analyzeRepository } from "../src/index.ts";
import { defaultCacheDir } from "../src/util/cache.ts";

const execFileAsync = promisify(execFile);
const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { days: { type: "string", default: "180" }, show: { type: "string" } } });
/** --show <kind>: print each graded finding of that kind with its outcome, to read what did not move. */
const show = values.show;
const days = Number(values.days);
const cacheDir = defaultCacheDir();

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout;
}

interface Tally { total: number; resolved: number; targeted: number; fileGone: number }
const tallies = new Map<string, Tally>();
const tally = (key: string, outcome: keyof Tally) => {
  const t = tallies.get(key) ?? { total: 0, resolved: 0, targeted: 0, fileGone: 0 };
  t.total++;
  if (outcome === "targeted") { t.resolved++; t.targeted++; } else if (outcome !== "total") t[outcome]++;
  tallies.set(key, t);
};

/**
 * Was the line removed by a focused commit (at most 50 files), or swept away by a large refactor?
 * Same criterion as packages/eval: the first commit after the old one in which the text is absent from
 * the file (git log -S also lists commits that merely added another occurrence) decides.
 */
async function removalKind(dir: string, oldSha: string, headSha: string, path: string, text: string): Promise<"targeted" | "resolved"> {
  try {
    const shas = (await git(dir, ["log", "--reverse", "--format=%H", `-S${text}`, `${oldSha}..${headSha}`, "--", path])).trim().split("\n").filter(Boolean);
    for (const sha of shas) {
      let present = true;
      try { await git(dir, ["grep", "-q", "-F", "-e", text, sha, "--", path]); } catch { present = false; }
      if (present) continue;
      const files = (await git(dir, ["show", "--format=", "--name-only", sha])).split("\n").filter(Boolean).length;
      return files <= 50 ? "targeted" : "resolved";
    }
    return "resolved";
  } catch {
    return "resolved";
  }
}

for (const repo of positionals) {
  try {
    await backtestRepo(repo);
  } catch (error) {
    console.error(`${repo}: skipped (${(error as Error).message.split("\n")[0].slice(0, 160)})`);
  }
}

async function backtestRepo(repo: string): Promise<void> {
  const [owner, name] = repo.split("/") as [string, string];
  const dir = join(cacheDir, "repos", `${owner}__${name}`);
  // Make sure the clone exists and is current, then find the commit from N days ago on the default branch.
  await analyzeRepository(repo, { skipSamples: true, checkLinks: false, dependencyChecks: false, maxOpportunities: 1 });
  const head = (await git(dir, ["rev-parse", "origin/HEAD"])).trim();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const old = (await git(dir, ["rev-list", "-1", `--before=${since}`, "origin/HEAD"])).trim();
  if (!old) { console.error(`${repo}: no commit before ${since.slice(0, 10)}`); return; }
  const report = await analyzeRepository({ owner, name, ref: old }, { skipSamples: true, checkLinks: false, dependencyChecks: false, maxOpportunities: 200, noKindCaps: true });
  const stillThere = async (path: string, text: string): Promise<"targeted" | "resolved" | "fileGone" | "total"> => {
    try { await git(dir, ["cat-file", "-e", `${head}:${path}`]); } catch { return "fileGone"; }
    try {
      await git(dir, ["grep", "-q", "-F", "-e", text, head, "--", path]);
      return "total"; // still present
    } catch {
      // Moved elsewhere in the tree is not fixed (same rule as packages/eval).
      try { await git(dir, ["grep", "-q", "-F", "-e", text, head]); return "total"; } catch { /* absent everywhere */ }
      return removalKind(dir, old, head, path, text);
    }
  };
  // Control: random non-blank lines from the same files at the old commit. Their survival rate is ordinary churn.
  const controlFiles = new Set<string>();
  for (const o of report.opportunities) for (const e of o.evidence) if (e.kind === "file" && /:\d+$/.test(e.locator)) controlFiles.add(e.locator.replace(/:\d+$/, ""));
  for (const path of [...controlFiles].slice(0, 40)) {
    let blob: string;
    try { blob = await git(dir, ["show", `${old}:${path}`]); } catch { continue; }
    const lines = blob.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12);
    for (let i = 0; i < 3 && lines.length > 0; i++) {
      const line = lines[Math.floor(Math.random() * lines.length)]!;
      tally("control (random lines)", await stillThere(path, line.slice(0, 80)));
    }
  }
  for (const o of report.opportunities) {
    const key = o.kind === "test_gap" || o.kind === "hygiene" ? `${o.kind}:${o.evidence[0]?.locator.startsWith("git log") ? "untested" : o.evidence[0]?.kind === "file" ? o.evidence[0].locator.split(":")[0] : "other"}` : o.kind;
    if (o.kind === "deprecation" || o.kind === "ci_rot" || o.kind === "tech_debt" || o.kind === "broken_link" || o.kind === "docs_drift") {
      const fileEv = o.evidence.filter((e) => e.kind === "file" && e.excerpt && /:\d+$/.test(e.locator));
      for (const e of fileEv.slice(0, 5)) {
        const path = e.locator.replace(/:\d+$/, "");
        const outcome = await stillThere(path, e.excerpt!.replace(/…$/, "").slice(0, 80));
        tally(o.kind, outcome);
        if (show === o.kind) console.log(`  [${outcome === "total" ? "still there" : outcome}] ${repo} ${e.locator} ${e.excerpt!.slice(0, 90)}${e.note ? ` (${e.note.slice(0, 80)})` : ""}`);
      }
    } else if (o.kind === "test_gap" && o.title.startsWith("Add tests for ")) {
      const file = o.title.slice("Add tests for ".length);
      const stem = file.split("/").pop()!.replace(/\.[^.]+$/, "");
      const testDirs = report.profile.structure.testDirs.length ? report.profile.structure.testDirs : ["tests", "test", "spec", "__tests__"];
      let found = false;
      try { await git(dir, ["grep", "-q", "-i", "-w", "-F", "-e", stem, head, "--", ...testDirs]); found = true; } catch { found = false; }
      let exists = true;
      try { await git(dir, ["cat-file", "-e", `${head}:${file}`]); } catch { exists = false; }
      tally("test_gap:untested", !exists ? "fileGone" : found ? "resolved" : "total");
    } else if (o.kind === "hygiene") {
      const wanted = /license/i.test(o.title) ? /^(LICENSE|LICENCE|COPYING)/i : /py\.typed/.test(o.title) ? /py\.typed$/ : /CI workflow/.test(o.title) ? /^\.github\/workflows\/.*\.ya?ml$/ : /requires-python/.test(o.title) ? /^pyproject\.toml$/ : undefined;
      if (!wanted) continue;
      const files = (await git(dir, ["ls-tree", "-r", "--name-only", head, "--", ".github", "pyproject.toml", "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", ...report.profile.ecosystems.flatMap((e) => e.manifests)])).split("\n");
      const present = files.some((f) => wanted.test(f)) || (/py\.typed/.test(o.title) && (await git(dir, ["ls-tree", "-r", "--name-only", head]).catch(() => "")).split("\n").some((f) => wanted.test(f)));
      // requires-python needs a content check
      let resolved = present;
      if (/requires-python/.test(o.title) && present) { try { await git(dir, ["grep", "-q", "-E", "-e", "requires-python|python_requires", head, "--", "pyproject.toml", "setup.py", "setup.cfg"]); } catch { resolved = false; } }
      tally(`hygiene:${o.title.split(" ").slice(0, 3).join(" ")}`, resolved ? "resolved" : "total");
    }
    void key;
  }
  console.error(`${repo}: ${old.slice(0, 8)} (${since.slice(0, 10)}) -> ${head.slice(0, 8)}: ${report.opportunities.length} findings graded`);
}


console.log("\nkind | findings | gone at HEAD | by a targeted commit (<=50 files) | file gone | gone rate | targeted rate");
let T = { total: 0, resolved: 0, targeted: 0, fileGone: 0 };
for (const [kind, t] of [...tallies.entries()].sort()) {
  const live = t.total - t.fileGone;
  console.log(`${kind} | ${t.total} | ${t.resolved} | ${t.targeted} | ${t.fileGone} | ${live ? Math.round((t.resolved / live) * 100) : 0}% | ${live ? Math.round((t.targeted / live) * 100) : 0}%`);
  T.total += t.total; T.resolved += t.resolved; T.targeted += t.targeted; T.fileGone += t.fileGone;
}
const live = T.total - T.fileGone;
console.log(`ALL | ${T.total} | ${T.resolved} | ${T.targeted} | ${T.fileGone} | ${live ? Math.round((T.resolved / live) * 100) : 0}% | ${live ? Math.round((T.targeted / live) * 100) : 0}%`);
