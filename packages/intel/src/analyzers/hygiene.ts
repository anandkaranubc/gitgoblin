import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { type Analyzer, type Finding, evidence } from "./types.ts";

const SOFTWARE = new Set(["library", "cli", "framework", "application", "plugin"]);

export const hygieneAnalyzer: Analyzer = {
  name: "hygiene",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (!SOFTWARE.has(profile.nature)) return [];
    const findings: Finding[] = [];
    const has = (re: RegExp) => ctx.inventory.files.some((f) => re.test(f.path));
    const tests = ctx.inventory.files.filter((f) => !f.vendored && f.category === "test").length;
    const mentionsLicense = (ctx.samples?.openIssues ?? []).find((i) => /\blicen[cs]e\b/i.test(i.title));

    if (!profile.license && !has(/^(LICENSE|LICENCE|COPYING|UNLICENSE)(\.|$)/i)) {
      findings.push({
        kind: "hygiene",
        clusterKey: "license",
        title: "Ask the maintainer to add a license",
        summary: "There is no LICENSE file and GitHub detects no license, so legally nobody may use, copy or contribute to this code.",
        evidence: [evidence(ctx, "api", `/repos/${ctx.ref.owner}/${ctx.ref.name}`, { note: "license: null" }), evidence(ctx, "computed", "file inventory", { note: "no LICENSE, LICENCE or COPYING file" })],
        files: [],
        effort: "trivial",
        skills: ["community"],
        approach: ["Open an issue explaining that without a license the project is all-rights-reserved by default, and ask which license the maintainer intends.", "Offer a PR adding the chosen license text and a `license` field in the package manifest."],
        acceptanceCriteria: ["A LICENSE file chosen by the maintainer is in the repository root and GitHub detects it."],
        etiquette: ["Never pick the license yourself; it is the owner's decision."],
        risks: ["Some owners intentionally leave code unlicensed."],
        signals: {
          value: Math.min(0.8, 0.4 + profile.stars / 500),
          valueReason: `unlicensed code with ${profile.stars} stars blocks every downstream user`,
          feasibility: 0.6, feasibilityReason: "trivial once the maintainer decides",
          confidence: 0.95, confidenceReason: "no license file and no GitHub-detected license",
          novelty: mentionsLicense ? 0.05 : 0.9,
          noveltyReason: mentionsLicense ? `issue #${mentionsLicense.number} already asks about the license` : "no open issue mentions a license",
        },
      });
    }

    const testCommand = profile.ecosystems.find((e) => e.commands.test)?.commands.test;
    if (profile.ci.provider === "none" && tests >= 3 && testCommand && ["library", "cli", "framework"].includes(profile.nature)) {
      findings.push({
        kind: "hygiene",
        clusterKey: "ci",
        title: "Add a CI workflow that runs the existing test suite",
        summary: `The repository has ${tests} test files but no CI configuration, so pull requests are not checked automatically.`,
        evidence: [evidence(ctx, "computed", "file inventory", { note: `${tests} test files; no .github/workflows or other CI config` })],
        files: profile.ecosystems[0]?.manifests.slice(0, 1) ?? [],
        effort: "small",
        skills: ["github-actions"],
        approach: [`Add .github/workflows/ci.yml that installs dependencies and runs ${testCommand} on pushes and pull requests.`, "Use the runtime versions the project claims to support as a matrix.", "Keep it minimal; do not add linting or coverage unless asked."],
        acceptanceCriteria: ["The workflow passes on the default branch and runs for pull requests."],
        etiquette: ["Offer it in an issue first if the maintainer has not mentioned CI; some prefer other services."],
        risks: ["Maintainers may run tests elsewhere or dislike GitHub Actions."],
        signals: { value: 0.55, valueReason: "unchecked PRs are how regressions land", feasibility: 0.8, feasibilityReason: `test command is known (${testCommand})`, confidence: 0.9, confidenceReason: "no CI config present and tests exist", welcomenessFactor: 0.8 },
      });
    }

    const py = ctx.manifests.python;
    if (py && profile.nature === "library" && py.packageDirs.length > 0 && !py.hasPyTyped) {
      let annotated = 0;
      let checked = 0;
      for (const f of ctx.inventory.files.filter((f) => !f.vendored && f.ext === ".py" && f.category === "source" && py.packageDirs.some((d) => f.path.startsWith(`${d}/`))).slice(0, 40)) {
        const text = await ctx.read(f.path, 100 * 1024);
        if (!text) continue;
        checked++;
        if (/\)\s*->\s*[\w[\]., |"']+\s*:/.test(text) || /^from typing import/m.test(text)) annotated++;
      }
      if (checked >= 3 && annotated / checked >= 0.5) {
        findings.push({
          kind: "hygiene",
          clusterKey: "py-typed",
          title: "Ship a py.typed marker so type checkers use the package's annotations",
          summary: `${annotated} of ${checked} sampled modules carry type annotations, but without a py.typed file (PEP 561) mypy and pyright ignore them for downstream users.`,
          evidence: [evidence(ctx, "computed", py.packageDirs[0]!, { note: `${annotated}/${checked} sampled modules have annotations; no py.typed` })],
          files: [py.packageDirs[0]!, py.paths[0]!],
          effort: "small",
          skills: ["python", "typing"],
          approach: [`Add an empty ${py.packageDirs[0]}/py.typed and make sure it is included in package data.`, "Run mypy (or pyright) on the package and fix or ignore what surfaces, keeping the change small.", "Mention PEP 561 in the PR."],
          acceptanceCriteria: ["Installing the package and importing it in a mypy-checked project resolves types without stubs."],
          risks: ["If the annotations are incomplete, maintainers may want them finished first."],
          signals: { value: 0.5, valueReason: "unlocks type checking for every downstream user", feasibility: 0.85, feasibilityReason: "mostly a one-file change", confidence: 0.75, confidenceReason: "annotation sampling is heuristic", welcomenessFactor: 0.9 },
        });
      }
    }
    if (py && py.name && profile.nature === "library" && !py.requiresPython && py.paths.some((p) => /pyproject\.toml|setup\.(py|cfg)/.test(p))) {
      findings.push({
        kind: "hygiene",
        clusterKey: "requires-python",
        title: "Declare the supported Python versions with requires-python",
        summary: "The package metadata does not say which Python versions it supports, so pip may install it on interpreters where it cannot run.",
        evidence: [evidence(ctx, "file", py.paths[0]!, { note: "no requires-python / python_requires" })],
        files: [py.paths[0]!],
        effort: "trivial",
        skills: ["python", "packaging"],
        approach: ["Check which versions CI tests and add `requires-python = \">=3.X\"` to pyproject.toml (or python_requires in setup).", "Add matching classifiers."],
        acceptanceCriteria: ["Metadata declares requires-python and it matches the CI matrix."],
        signals: { value: 0.3, valueReason: "prevents confusing install failures", feasibility: 0.9, feasibilityReason: "one line", confidence: 0.9, confidenceReason: "field absent from the manifest", welcomenessFactor: 0.85 },
      });
    }
    return findings;
  },
};
