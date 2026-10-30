/**
 * Every function that reads text an outsider controls (issue titles and bodies, comments, READMEs,
 * CONTRIBUTING, source files, workflow files, lockfiles) must stay fast on hostile input. A regular
 * expression that backtracks across a 64 KB line can freeze an analysis for hours, synchronously,
 * in the CLI or in a long-running MCP server. This sweep feeds each of them a set of adversarial
 * inputs at GitHub's issue-body limit and fails if any call takes longer than the ceiling.
 */
import { hasPwnRequest, matchCiRules } from "../src/analyzers/ci-rot.ts";
import { DEPRECATION_RULES } from "../src/analyzers/deprecation-rules.ts";
import { matchDeprecations, isCompatModule } from "../src/analyzers/deprecations.ts";
import { cliFlagsInCode, cliFlagsInDocs, codeBlocks, installCommands, jsExports, jsNamedImports, pythonDefines } from "../src/analyzers/docs-drift.ts";
import { looksAnnotated } from "../src/analyzers/hygiene.ts";
import { permalinks, quotedCodeLines, tracebackFrames } from "../src/analyzers/issue-drift.ts";
import { asksMaintainersToChoose, issueBody, problemStatement } from "../src/analyzers/issue-text.ts";
import { assessIssue, looksLikeRequestTitle, plainText } from "../src/analyzers/issues.ts";
import { anchorsIn, extractLinks, siteSlugify, slugify } from "../src/analyzers/links.ts";
import { parseLockfile } from "../src/analyzers/lockfiles.ts";
import { findDebtMarkers } from "../src/analyzers/tech-debt.ts";
import { findSkippedTests, stemWords } from "../src/analyzers/test-gaps.ts";
import { looksGenerated } from "../src/analyzers/types.ts";
import { pythonApiDocs, tsApiDocs } from "../src/analyzers/api-docs.ts";
import { referencedIssues } from "../src/forge/common.ts";
import type { IssueSample } from "../src/github/types.ts";
import { unquoted } from "../src/github/types.ts";
import { requireBlockLines } from "../src/manifests/go.ts";
import { applySetupCfg, applySetupPy, parseRequirements } from "../src/manifests/python.ts";
import type { PythonManifest } from "../src/manifests/types.ts";
import { goTargets, jsTargets, pythonTargets, rustTargets } from "../src/profile/imports.ts";
import { licenseFromText } from "../src/profile/license.ts";
import { earlyClosedReason, extractRules, findDeprecationNotice, findRefusal } from "../src/profile/welcomeness.ts";
import { maskCodeLiterals } from "../src/util/mask.ts";
import { inline, stripControl } from "../src/util/text.ts";
import { renderIssue } from "../src/llm/issue-review.ts";

export const SIZE = Number(process.env.REDOS_SIZE ?? 65_536);
export const CEILING_MS = Number(process.env.REDOS_CEILING_MS ?? 1500);

const UNITS = [
  " ", "\t", "\n", "<", ">", "[", "]", "(", ")", "!", "#", "`", "~", "*", "_", "-", ".", "/", ":", "a", "1", "@", "\\", "'", '"', "|", "{", "=", "&", "%",
  "a ", "<!--", "![", "](", "[x](", "```\n", "# ", "#\n", "- [ ] ", "http://", "https://a", "a.", "a/", "a-", "a_", "a.b", "TODO ", "# TODO ", "// TODO(",
  "it.skip(", 'File "', '  File "a", line 1, in f\n', "    at ", ">>> ", "fixes #1 ", "see #", ".. _a: ", "`a <", "{: #", '<a href="', "github.com/a/b/blob/",
  "\\(", "a@", "we are not ", "not accepting ", "deprecated ", "issue ", "uses: a@", "run: ", "${{ ", "import ", "from . import ", "use crate::", "mod a;",
  "def a(", "export ", '"""', "'''", "/*", "*/", "\\\\", "a\\", "--", "-- a", "a=1&", "v1.2.", "1.2.3.", ">=1,", "; python_version", "#!", "​", "😀",
];

/** Openers of the patterns that read headings, attributes, annotations, licenses, installs and imports. */
const PREFIXES = ["#", "# ", "## a", "{:", "{: #a", ")", ") ->", "Eclipse Public License", "install_requires =\n", "name =", "pip install", "npm install -", "from a import", "import a", "#[arg(", "we", "a as", "[a](", "[a]: ", "_a", "File \"a\", line 1, in f\n", "    at f (", "Error", "use crate::", "a."];
const FILLERS = [" ", "\t", "-", "_", "a", "#", "\n ", ",", "A"];

export function* inputs(): Generator<[string, string]> {
  for (const unit of UNITS) {
    const body = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    yield [JSON.stringify(unit), body];
    // A different final character defeats patterns that only succeed at the end.
    yield [`${JSON.stringify(unit)}+!`, `${body.slice(0, -1)}!`];
  }
  // The shape catastrophic-backtracking attacks take: a pattern's opener, a long run it can split many ways, a mismatch.
  for (const prefix of PREFIXES) {
    for (const filler of FILLERS) {
      const run = filler.repeat(Math.ceil((SIZE - prefix.length - 1) / filler.length)).slice(0, SIZE - prefix.length - 1);
      yield [`${JSON.stringify(prefix)}+${JSON.stringify(filler)}*+!`, `${prefix}${run}!`];
    }
  }
}

function issue(title: string, body: string): IssueSample {
  return {
    number: 1, title, url: "https://github.com/o/r/issues/1", body, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    closedAt: undefined, labels: [], assignees: [], author: { login: "x", isBot: false }, association: "NONE", commentCount: 1, reactions: 0,
    firstComments: [{ body, createdAt: "2026-01-01T01:00:00Z", author: { login: "y", isBot: false }, association: "MEMBER" }],
    lastComments: [{ body, createdAt: "2026-01-01T01:00:00Z", author: { login: "y", isBot: false }, association: "MEMBER" }],
    linkedPrs: [], locked: false, stateReason: undefined,
  } as unknown as IssueSample;
}

function emptyManifest(): PythonManifest {
  return { paths: [], dependencies: [], classifierVersions: [], scripts: [], tools: [], packageDirs: [] } as unknown as PythonManifest;
}

const ref = { host: "github.com", owner: "o", name: "r" };
const none = new Set<string>();
export const FUNCTIONS: [string, (t: string) => unknown][] = [
  ["issueBody", issueBody],
  ["problemStatement", problemStatement],
  ["asksMaintainersToChoose", asksMaintainersToChoose],
  ["plainText", plainText],
  ["looksLikeRequestTitle", (t) => looksLikeRequestTitle(t.slice(0, 256))],
  ["assessIssue", (t) => assessIssue(issue(t.slice(0, 256), t), new Date("2026-06-01T00:00:00Z"), true, "https://github.com/o/r")],
  ["unquoted", unquoted],
  ["quotedCodeLines", quotedCodeLines],
  ["tracebackFrames", tracebackFrames],
  ["permalinks", (t) => permalinks(t, ref)],
  ["referencedIssues", referencedIssues],
  ["extractLinks md", (t) => extractLinks("README.md", t)],
  ["extractLinks rst", (t) => extractLinks("docs/index.rst", t)],
  ["anchorsIn", anchorsIn],
  ["slugify", (t) => slugify(t.slice(0, 2000))],
  ["siteSlugify", (t) => siteSlugify(t.slice(0, 2000))],
  ["codeBlocks", (t) => codeBlocks("README.md", t)],
  ["cliFlagsInDocs", (t) => cliFlagsInDocs(t, ["tool"])],
  ["cliFlagsInCode", cliFlagsInCode],
  ["findRefusal", (t) => findRefusal(t)],
  ["findDeprecationNotice", (t) => findDeprecationNotice(t, t.slice(0, 350))],
  ["earlyClosedReason", (t) => earlyClosedReason({ archived: false, disabled: false, description: t.slice(0, 350) }, t, t)],
  ["licenseFromText", licenseFromText],
  ["findDebtMarkers py", (t) => findDebtMarkers("a.py", t)],
  ["findDebtMarkers ts", (t) => findDebtMarkers("a.ts", t)],
  ["findSkippedTests ts", (t) => findSkippedTests("a.test.ts", t)],
  ["findSkippedTests py", (t) => findSkippedTests("test_a.py", t)],
  ["matchDeprecations py", (t) => matchDeprecations("a.py", t, DEPRECATION_RULES.filter((r) => r.ecosystem === "python"))],
  ["matchDeprecations js", (t) => matchDeprecations("a.js", t, DEPRECATION_RULES.filter((r) => r.ecosystem === "node"))],
  ["matchDeprecations go", (t) => matchDeprecations("a.go", t, DEPRECATION_RULES.filter((r) => r.ecosystem === "go"))],
  ["matchDeprecations rs", (t) => matchDeprecations("a.rs", t, DEPRECATION_RULES.filter((r) => r.ecosystem === "rust"))],
  ["isCompatModule", (t) => isCompatModule("a.py", t.slice(0, 2000))],
  ["matchCiRules", (t) => matchCiRules(".github/workflows/ci.yml", t)],
  ["hasPwnRequest", hasPwnRequest],
  ["looksGenerated", looksGenerated],
  ["pythonApiDocs", (t) => pythonApiDocs("a.py", t)],
  ["tsApiDocs", (t) => tsApiDocs("a.ts", t)],
  ["pythonTargets", (t) => pythonTargets("pkg/a.py", t, none)],
  ["jsTargets", (t) => jsTargets("src/a.ts", t, none)],
  ["goTargets", (t) => goTargets("a/a.go", t, "example.com/m", none)],
  ["rustTargets", (t) => rustTargets("src/a.rs", t, none)],
  ["parseRequirements", (t) => parseRequirements(t, false)],
  ["parseLockfile npm", (t) => parseLockfile("package-lock.json", `{"packages":{"":{}},"x":${JSON.stringify(t)}}`)],
  ["parseLockfile poetry", (t) => parseLockfile("poetry.lock", t)],
  ["parseLockfile cargo", (t) => parseLockfile("Cargo.lock", t)],
  ["parseLockfile go.sum", (t) => parseLockfile("go.sum", t)],
  ["parseLockfile yarn", (t) => parseLockfile("yarn.lock", t)],
  ["mask js", (t) => maskCodeLiterals(t, "js")],
  ["mask py", (t) => maskCodeLiterals(t, "py")],
  ["mask rs", (t) => maskCodeLiterals(t, "rs")],
  ["mask c", (t) => maskCodeLiterals(t, "c")],
  ["installCommands", installCommands],
  ["looksAnnotated", looksAnnotated],
  ["stemWords", (t) => stemWords(t.slice(0, 255))],
  ["applySetupCfg", (t) => applySetupCfg(emptyManifest(), t)],
  ["applySetupPy", (t) => applySetupPy(emptyManifest(), t)],
  ["renderIssue", (t) => renderIssue(issue(t.slice(0, 256), t), new Date("2026-06-01T00:00:00Z"))],
  ["stripControl", stripControl],
  ["inline", (t) => inline(t)],
];

/**
 * Repository files are read whole, up to 512 KB (lockfiles and go.mod up to 8 MB), so a pattern that
 * restarts a scan at every occurrence of its opener is quadratic in the file and only shows at file
 * size: 200 ms at 64 KB is 13 s at 512 KB. Each case repeats the opener that made one such pattern
 * rescan the rest of the file or line.
 */
export const FILE_SIZE = Number(process.env.REDOS_FILE_SIZE ?? 512 * 1024);
export const FILE_CASES: [string, (t: string) => unknown, string][] = [
  ["parseLockfile go.mod", (t) => parseLockfile("go.mod", t), "require (\n"],
  ["requireBlockLines", requireBlockLines, "require (\n"],
  ["pythonDefines blank lines", (t) => pythonDefines(t, "Missing"), "\n"],
  ["pythonDefines annotations", (t) => pythonDefines(t, "Missing"), "Missing:\n"],
  ["pythonDefines import", (t) => pythonDefines(t, "Missing"), "import "],
  ["pythonDefines __all__", (t) => pythonDefines(t, "Missing"), "__all__ "],
  ["jsExports export {", (t) => jsExports(t, "Foo"), "export {a\n"],
  ["jsExports module.exports", (t) => jsExports(t, "Foo"), "module.exports={"],
  ["jsNamedImports import {", (t) => jsNamedImports(t, "pkg"), "import {"],
  ["jsNamedImports const {", (t) => jsNamedImports(t, "pkg"), "const {"],
  ["anchorsIn heading <", anchorsIn, "# <"],
  ["cliFlagsInCode cobra", cliFlagsInCode, "Flags().a("],
  ["matchCiRules python-version", (t) => matchCiRules(".github/workflows/ci.yml", t), "python-version:"],
  ["findSkippedTests xfail", (t) => findSkippedTests("test_a.py", `@pytest.mark.skip ${t}`), "xfail("],
  ["extractRules PR template", (t) => extractRules({ inventory: { files: [], byPath: new Map(), totalCount: 0, truncated: false }, docs: { prTemplate: t }, samples: undefined }), "[ ] "],
];
