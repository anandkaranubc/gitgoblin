import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { compareVersions } from "../manifests/python.ts";
import { minimumPython } from "./tech-debt.ts";
import { DEPRECATED_CRATES, DEPRECATED_GO_MODULES, DEPRECATED_NPM, DEPRECATION_RULES, type DeprecationRule, type Ecosystem, LATEST_PYTHON, PYTHON_EOL } from "./deprecation-rules.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

const EXT: Record<Ecosystem, RegExp> = { python: /\.pyi?$/, node: /\.[cm]?[jt]sx?$/, go: /\.go$/, rust: /\.rs$/ };

export interface PythonRange {
  min: string | undefined;
  /** Highest minor the project can run on: an explicit `<` bound, or the newest release. */
  max: string;
}

export function pythonRange(requires: string | undefined, classifiers: string[]): PythonRange {
  const min = minimumPython(requires, classifiers);
  let max = LATEST_PYTHON;
  const upper = requires ? /<\s*(\d)\.(\d+)/.exec(requires) : undefined;
  if (upper) max = `${upper[1]}.${Number(upper[2]) - 1}`;
  else if (requires && /^\s*~=\s*(\d\.\d+)/.test(requires)) max = LATEST_PYTHON;
  return { min, max };
}

/** Does this rule matter for a project that may run on any Python up to `range.max`? */
export function ruleApplies(rule: DeprecationRule, range: PythonRange): boolean {
  if (!rule.removedIn) return true;
  return compareVersions(rule.removedIn, range.max) <= 0;
}

export interface RuleMatch {
  rule: DeprecationRule;
  path: string;
  line: number;
  text: string;
  /** Inside a try/except or version check, so probably a deliberate shim. */
  guarded: boolean;
}

export function matchDeprecations(path: string, text: string, rules: DeprecationRule[]): RuleMatch[] {
  const out: RuleMatch[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const code = line.replace(/\s(#|\/\/).*$/, "");
    if (/^\s*(#|\/\/|\*|\/\*)/.test(line)) continue;
    for (const rule of rules) {
      if (!rule.pattern.test(code)) continue;
      const guarded = isGuarded(lines, i) || /\s#\s*(noqa|type: ignore|pragma)/.test(line);
      out.push({ rule, path, line: i + 1, text: line.trim(), guarded });
    }
  }
  return out;
}

/** Inside a try/except, version check or TYPE_CHECKING block that starts on a less-indented line above. */
function isGuarded(lines: string[], i: number): boolean {
  const indent = lines[i]!.search(/\S/);
  for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
    const prev = lines[j]!;
    const prevIndent = prev.search(/\S/);
    if (prevIndent === -1) continue;
    if (prevIndent < indent && /^\s*(try\s*:|except\b|if\s+(sys\.version_info|TYPE_CHECKING|PY2|PY3|six\.PY)|else\s*:)/.test(prev)) return true;
    if (prevIndent < indent && /^\s*(if|elif|else|try|except|def|class|with|for|while)\b/.test(prev)) return false;
  }
  return false;
}

export const deprecationsAnalyzer: Analyzer = {
  name: "deprecations",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (["awesome_list", "docs", "config", "tutorial", "data", "template"].includes(profile.nature)) return [];
    const findings: Finding[] = [];
    const { python, node, go, rust } = ctx.manifests;
    const active: Ecosystem[] = [];
    if (python) active.push("python");
    if (node) active.push("node");
    if (go) active.push("go");
    if (rust) active.push("rust");
    if (active.length === 0) {
      // No manifest, but code may still be there (scripts, plugins): infer from files.
      for (const eco of Object.keys(EXT) as Ecosystem[]) if (ctx.inventory.files.some((f) => !f.vendored && f.category === "source" && EXT[eco].test(f.path))) active.push(eco);
    }
    const range = pythonRange(python?.requiresPython, python?.classifierVersions ?? []);
    const rules = DEPRECATION_RULES.filter((r) => active.includes(r.ecosystem) && (r.ecosystem !== "python" || ruleApplies(r, range)))
      // `six` only matters once Python 2 is really gone from the claimed range.
      .filter((r) => r.id !== "py-six" || (range.min !== undefined && compareVersions(range.min, "3.0") >= 0));
    if (rules.length === 0) return findings;

    const matcher = new RegExp(active.map((e) => EXT[e].source).join("|"));
    let scanned = 0;
    for await (const { path, text } of textFiles(ctx, (p) => matcher.test(p) && ctx.inventory.byPath.get(p)?.category !== "docs", 3000)) {
      scanned++;
      for (const m of matchDeprecations(path, text, rules)) {
        const removed = m.rule.severity === "removed";
        findings.push({
          kind: "deprecation",
          clusterKey: m.rule.id,
          title: m.rule.title,
          summary: removed && m.rule.removedIn
            ? `${m.rule.detail} The project ${range.min ? `supports Python ${range.min} through ${range.max}` : `does not cap its Python version`}, so this code path fails on ${m.rule.removedIn}+.`
            : m.rule.detail,
          evidence: [evidence(ctx, "file", `${m.path}:${m.line}`, { excerpt: m.text, note: m.guarded ? "inside a try/except or version guard; may be an intentional shim" : undefined })],
          files: [m.path],
          effort: "small",
          skills: [m.rule.ecosystem],
          approach: [m.rule.fix, "Keep behaviour identical and run the test suite on the newest supported runtime.", `Link ${m.rule.reference} in the PR.`],
          acceptanceCriteria: ["No remaining references to the deprecated API in non-vendored code.", "Tests pass on the newest supported runtime without deprecation warnings for this API."],
          risks: m.guarded ? ["Guarded usage may be a deliberate compatibility shim; confirm the supported range before removing."] : ["If the project secretly still supports an older runtime, the replacement must work there too."],
          signals: {
            value: removed ? 0.75 : m.rule.id === "py-pkg-resources" ? 0.5 : 0.42,
            valueReason: removed ? `code fails outright on Python ${m.rule.removedIn}+` : "warnings now, breakage later; replacement is well documented",
            feasibility: 0.9,
            feasibilityReason: "mechanical replacement with a documented equivalent",
            confidence: m.guarded ? 0.5 : removed ? 0.9 : 0.85,
            confidenceReason: m.guarded ? "usage is guarded, so it may be intentional" : "exact pattern match in source, gated on the project's declared runtime range",
            welcomenessFactor: removed ? 1 : 0.85,
          },
        });
      }
      if (findings.length > 300) {
        ctx.budget.cut("stopped collecting deprecations after 300 matches");
        break;
      }
    }
    void scanned;

    // Deprecated dependencies, straight from the manifests.
    for (const dep of node?.dependencies ?? []) {
      const info = DEPRECATED_NPM[dep.name];
      if (info) findings.push(depFinding(ctx, "node", dep.name, dep.dev, info, node!.paths[0]!));
    }
    for (const dep of rust?.dependencies ?? []) {
      const info = DEPRECATED_CRATES[dep.name];
      if (info) findings.push(depFinding(ctx, "rust", dep.name, dep.dev, info, rust!.paths[0]!));
    }
    for (const dep of go?.dependencies ?? []) {
      const key = Object.keys(DEPRECATED_GO_MODULES).find((k) => dep.name === k || dep.name.startsWith(`${k}/`));
      if (key && !dep.dev) findings.push(depFinding(ctx, "go", dep.name, false, DEPRECATED_GO_MODULES[key]!, go!.paths[0]!));
    }

    // Claimed support for end-of-life Pythons.
    if (python) {
      const eol = python.classifierVersions.filter((v) => PYTHON_EOL[v] && PYTHON_EOL[v]! < ctx.nowIso.slice(0, 10));
      if (eol.length > 0) {
        findings.push({
          kind: "deprecation",
          clusterKey: "python-eol-classifiers",
          title: `Stop advertising support for end-of-life Python ${eol.join(", ")}`,
          summary: `The package classifiers list Python ${eol.join(", ")}, which no longer receive security fixes. Dropping them lets the project use newer syntax and shrink its CI matrix.`,
          evidence: [evidence(ctx, "file", python.paths[0]!, { note: `classifiers include ${eol.map((v) => `${v} (EOL ${PYTHON_EOL[v]})`).join(", ")}` })],
          files: python.paths,
          effort: "small",
          skills: ["python", "packaging"],
          approach: ["Open an issue proposing the drop and citing the EOL dates; maintainers decide.", "If agreed: raise requires-python, remove the classifiers and CI matrix entries, and bump the major or minor version as the project's policy requires."],
          acceptanceCriteria: ["Metadata, CI matrix and documentation agree on the supported versions."],
          etiquette: ["Dropping versions is a maintainer policy decision; ask first."],
          risks: ["Some projects deliberately support old Pythons for enterprise users."],
          signals: { value: 0.35, valueReason: "reduces maintenance burden; not user-visible", feasibility: 0.8, feasibilityReason: "metadata and CI edits", confidence: 0.9, confidenceReason: "classifier versions compared with the official EOL calendar", welcomenessFactor: 0.65, welcomenessReason: "support policy is the maintainers' call" },
        });
      }
    }
    return findings;
  },
};

function depFinding(ctx: AnalysisContext, eco: Ecosystem, name: string, dev: boolean, info: { fix: string; reference: string }, manifest: string): Finding {
  return {
    kind: "deprecation",
    clusterKey: `dep:${name}`,
    title: `Replace the deprecated ${eco === "rust" ? "crate" : eco === "go" ? "module" : "package"} ${name}`,
    summary: `${name} is unmaintained or deprecated upstream and has a well-known replacement.${dev ? " It is a development dependency, so the blast radius is small." : ""}`,
    evidence: [evidence(ctx, "file", manifest, { note: `${dev ? "dev " : ""}dependency on ${name}` })],
    files: [manifest],
    effort: dev ? "small" : "medium",
    skills: [eco],
    approach: [info.fix, "Search the code for every use of the old API and port it.", `Link ${info.reference} in the PR.`],
    acceptanceCriteria: [`${name} no longer appears in the manifest or lockfile; tests pass.`],
    risks: ["Replacing a dependency can change behaviour subtly; cover the ported code with tests."],
    signals: {
      value: dev ? 0.35 : 0.5,
      valueReason: dev ? "unmaintained tooling, limited user impact" : "unmaintained runtime dependency: no security fixes",
      feasibility: 0.7,
      feasibilityReason: "documented migration path",
      confidence: 0.95,
      confidenceReason: "dependency named in the manifest; upstream deprecation is public",
      welcomenessFactor: 0.8,
    },
  };
}
