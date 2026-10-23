import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

/**
 * Public API without documentation, in projects that otherwise document their API.
 * Measured, not opined: the project's own docstring or JSDoc coverage is the yardstick,
 * and only modules far below it are reported.
 */
export interface ApiDocStats {
  path: string;
  publicCount: number;
  documented: number;
  undocumented: string[];
  /** Line number and verbatim text of each undocumented definition, for evidence a reader can find. */
  undocumentedAt: { line: number; text: string }[];
}

const PY_PUBLIC = /^(?:    )?(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)\s*[(:]/gm;
const TS_PUBLIC = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Python: module-level and class-level public defs, documented when the next non-empty line opens a docstring. */
export function pythonApiDocs(path: string, text: string): ApiDocStats {
  const lines = text.split("\n");
  const stats: ApiDocStats = { path, publicCount: 0, documented: 0, undocumented: [], undocumentedAt: [] };
  for (const m of text.matchAll(PY_PUBLIC)) {
    const name = m[1]!;
    if (name.startsWith("_") || /^(test_|Test)/.test(name)) continue;
    const lineNo = text.slice(0, m.index).split("\n").length - 1;
    // Find the end of the signature (line ending with ':' not inside a comment), then the next non-blank line.
    let i = lineNo;
    while (i < lines.length && !/:\s*(#.*)?$/.test(lines[i]!)) i++;
    i++;
    while (i < lines.length && lines[i]!.trim() === "") i++;
    const next = lines[i]?.trim() ?? "";
    // Overloads and abstract stubs are not undocumented API.
    if (/^(\.\.\.|pass)$/.test(next) || /@overload/.test(lines[lineNo - 1] ?? "")) continue;
    stats.publicCount++;
    if (/^[rRbBuU]?("""|''')/.test(next)) stats.documented++;
    else {
      stats.undocumented.push(name);
      stats.undocumentedAt.push({ line: lineNo + 1, text: lines[lineNo]!.trim() });
    }
  }
  return stats;
}

/** TypeScript/JavaScript: exported declarations, documented when preceded by a JSDoc block. */
export function tsApiDocs(path: string, text: string): ApiDocStats {
  const stats: ApiDocStats = { path, publicCount: 0, documented: 0, undocumented: [], undocumentedAt: [] };
  const lines = text.split("\n");
  for (const m of text.matchAll(TS_PUBLIC)) {
    const name = m[1]!;
    const before = text.slice(0, m.index).trimEnd();
    stats.publicCount++;
    if (/\*\/$/.test(before) && /\/\*\*[\s\S]*\*\/$/.test(before.slice(-2000))) stats.documented++;
    else {
      const lineNo = text.slice(0, m.index).split("\n").length - 1;
      stats.undocumented.push(name);
      stats.undocumentedAt.push({ line: lineNo + 1, text: lines[lineNo]!.trim() });
    }
  }
  return stats;
}

export const apiDocsAnalyzer: Analyzer = {
  name: "api-docs",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (!["library", "framework", "plugin"].includes(profile.nature)) return [];
    const py = ctx.manifests.python;
    const node = ctx.manifests.node;
    const stats: ApiDocStats[] = [];
    if (py && py.packageDirs.length) {
      for await (const { path, text } of textFiles(ctx, (p) => py.packageDirs.some((d) => p.startsWith(`${d}/`)) && p.endsWith(".py") && !/(^|\/)(_[^/]*|tests?\/|conftest)/.test(p.split("/").pop() ?? "") && ctx.inventory.byPath.get(p)?.category === "source", 600)) {
        stats.push(pythonApiDocs(path, text));
      }
    } else if (node && !node.private) {
      for await (const { path, text } of textFiles(ctx, (p) => /\.[cm]?tsx?$/.test(p) && !/\.d\.ts$/.test(p) && /^(src|lib)\//.test(p) && ctx.inventory.byPath.get(p)?.category === "source", 600)) {
        stats.push(tsApiDocs(path, text));
      }
    } else return [];

    const total = stats.reduce((n, s) => n + s.publicCount, 0);
    const documented = stats.reduce((n, s) => n + s.documented, 0);
    if (total < 30) return [];
    const coverage = documented / total;
    // Only projects that document their API set a standard worth holding modules to.
    if (coverage < 0.5) return [];

    const hot = new Map(profile.hotFiles.map((h) => [h.path, h.commits365d]));
    const central = new Set((profile.structure.centralFiles ?? []).map((c) => c.path));
    const findings: Finding[] = [];
    for (const s of stats.filter((s) => s.publicCount >= 6 && s.documented / s.publicCount < Math.min(0.3, coverage / 2) && s.undocumented.length >= 5).sort((a, b) => b.undocumented.length - a.undocumented.length).slice(0, 3)) {
      const weight = (hot.has(s.path) ? 0.1 : 0) + (central.has(s.path) ? 0.1 : 0);
      findings.push({
        kind: "hygiene",
        clusterKey: `api-docs:${s.path}`,
        title: `Document the public API of ${s.path}`,
        summary: `${s.undocumented.length} of ${s.publicCount} public definitions in ${s.path} have no docstring${node ? " or JSDoc" : ""}, while the project documents ${Math.round(coverage * 100)}% of its public API overall.`,
        evidence: [
          evidence(ctx, "computed", s.path, { note: `${s.documented}/${s.publicCount} documented; project-wide ${documented}/${total} (${Math.round(coverage * 100)}%); undocumented: ${s.undocumented.slice(0, 8).join(", ")}${s.undocumented.length > 8 ? ", …" : ""}` }),
          // Excerpts are verbatim source lines, so a reader (or a grader) can find each one.
          ...s.undocumentedAt.slice(0, 3).map((d) => evidence(ctx, "file", `${s.path}:${d.line}`, { excerpt: d.text, note: "public definition without a docstring" })),
        ],
        files: [s.path],
        effort: "small",
        skills: [py ? "python" : "typescript", "docs"],
        approach: [
          `Read how neighbouring modules phrase their ${py ? "docstrings" : "JSDoc"} and follow that style exactly.`,
          `Document each public name in ${s.path}: what it does, parameters, return value, and raised errors or thrown exceptions where relevant.`,
          "Do not change behaviour or signatures in the same PR.",
        ],
        acceptanceCriteria: [`Every public definition in ${s.path} has a docstring consistent with the rest of the project.`, "Any docs build (Sphinx, mkdocs, typedoc) still passes."],
        etiquette: ["Keep it to one module per PR so review stays easy."],
        risks: ["Maintainers may consider some names internal despite the missing underscore; ask if unsure which are public."],
        signals: {
          value: Math.min(0.6, 0.35 + weight),
          valueReason: `undocumented API in a project that documents ${Math.round(coverage * 100)}% of it${hot.has(s.path) ? "; frequently changed" : ""}${central.has(s.path) ? "; imported widely" : ""}`,
          feasibility: 0.85,
          feasibilityReason: "writing docs requires reading the code, not changing it",
          confidence: 0.65,
          confidenceReason: "docstring presence detected by pattern; names may be internal by convention",
          welcomenessFactor: 0.9,
          welcomenessReason: "documentation of public API is usually welcome in documented projects",
        },
      });
    }
    return findings;
  },
};
