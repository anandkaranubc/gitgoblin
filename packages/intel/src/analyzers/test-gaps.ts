import { basename, dirname, extname } from "node:path";

import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { type FileEntry, isTestSpecFile } from "../fs/scan.ts";
import { maskCodeLiterals, maskLangFor } from "../util/mask.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

const CODE_LANGS = new Set(["Python", "JavaScript", "TypeScript", "Go", "Rust", "Java", "Kotlin", "Ruby", "PHP", "C#", "Swift", "Dart", "Elixir", "Scala", "C", "C++"]);
const GENERIC_STEMS = new Set(["utils", "util", "helpers", "helper", "main", "index", "app", "base", "core", "types", "_types", "typing", "_typing", "const", "constants", "config", "cli", "lib", "mod", "common", "errors", "exceptions", "models", "version", "__version__", "_version", "settings", "setup", "conftest", "__init__", "__main__", "init", "enums", "compat", "_compat"]);
const NOT_WORTH_TESTING = /^\.|(^|\/)(examples?|samples?|scripts?|benchmarks?|docs?|migrations|fixtures|__snapshots__|testdata|tools?|vendor|contrib|playground|sandbox|demos?|\w*build\w*|ci|packaging|release|dist|deploy\w*|infra\w*|hack|utils?)(\/|$)|(^|\/)(setup|conftest|settings|wsgi|asgi|manage|version|_version|__about__)\.py$|(^|\/)main\.go$|\.d\.ts$|\.config(\.\w+)*\.[cm]?[jt]s$|\.stories\.[jt]sx?$|(^|\/)test[-_]?(utils?|helpers?|support|setup)\.\w+$|(^|\/)([Gg]ulpfile|[Gg]runtfile|[Jj]akefile|Makefile)(\.[\w-]+)*\.[cm]?[jt]s$|(Interface|Trait|Exception|Abstract\w*)\.php$|(^|\/)(exceptions?|interfaces?|protocols?)\.py$/;

/** Base name a test file is most likely testing: test_foo.py -> foo, foo.test.ts -> foo, FooTest.java -> Foo. */
export function testedStem(testPath: string): string | undefined {
  const name = basename(testPath).replace(/\.[^.]+$/, "");
  const m =
    /^test_(.+)$/.exec(name) ??
    /^(.+)_test$/.exec(name) ??
    /^(.+)\.(test|spec)$/.exec(name) ??
    /^(.+)_spec$/.exec(name) ??
    /^(.+)Tests?$/.exec(name) ??
    /^(.+)\.e2e$/.exec(name);
  return m?.[1]?.toLowerCase();
}

export function sourceStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "").toLowerCase();
}

export interface TestIndex {
  stems: Set<string>;
  /** Lowercased words appearing in test sources (imports, identifiers). */
  mentions: Set<string>;
  goTestDirs: Set<string>;
  /** Distinctive words from test file names: test_file_palm.py contributes "palm". */
  nameWords: Set<string>;
}

const GENERIC_WORDS = new Set(["test", "tests", "spec", "file", "files", "image", "plugin", "plugins", "util", "utils", "helper", "helpers", "base", "core", "main", "index", "common", "data", "type", "types", "model", "models", "handler", "handlers", "service", "services", "client", "server", "module", "modules", "impl", "default", "basic", "simple", "general", "misc", "other", "integration", "unit", "e2e", "api", "app", "cli", "lib", "src", "run", "log", "cfg", "env", "net", "sys", "dev", "doc", "ext", "gui", "web", "new", "old", "all", "get", "set", "use", "the", "and", "for", "with", "from", "into", "when"]);

/** Words of a file stem split on CamelCase, digits, underscores and hyphens, lowercased, 3+ letters, non-generic (tga, pdf, palm). */
export function stemWords(stem: string): string[] {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]{1,40})([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

export function buildTestIndex(tests: { path: string; text: string | undefined }[]): TestIndex {
  const stems = new Set<string>();
  const mentions = new Set<string>();
  const goTestDirs = new Set<string>();
  const nameWords = new Set<string>();
  for (const t of tests) {
    const stem = testedStem(t.path);
    if (stem) stems.add(stem);
    for (const w of stemWords(basename(t.path).replace(/\.[^.]+$/, ""))) nameWords.add(w);
    if (t.path.endsWith("_test.go")) goTestDirs.add(dirname(t.path));
    if (!t.text) continue;
    for (const m of t.text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) mentions.add(m[0].toLowerCase());
  }
  return { stems, mentions, goTestDirs, nameWords };
}

/** True when nothing in the test suite seems to reference this source file. */
export function looksUntested(path: string, text: string, index: TestIndex): boolean {
  const stem = sourceStem(path);
  if (path.endsWith(".go")) return !index.goTestDirs.has(dirname(path));
  if (path.endsWith(".rs") && /#\[cfg\(test\)\]|#\[test\]/.test(text)) return false;
  if (stem.length < 4 || GENERIC_STEMS.has(stem)) return false; // too ambiguous to judge
  if (index.stems.has(stem)) return false;
  if (index.mentions.has(stem)) return false;
  // Python modules are imported by dotted path; a mention of the module token covers it.
  const camel = stem.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel !== stem && index.mentions.has(camel.toLowerCase())) return false;
  // test_file_palm.py covers PalmImagePlugin.py: a distinctive word shared with a test file name counts.
  const words = stemWords(basename(path).replace(/\.[^.]+$/, ""));
  // Nothing distinctive left to match on (redis's t_set.c is just "set", covered by tests/unit/type/set.tcl): too ambiguous to claim.
  if (words.length === 0) return false;
  if (words.some((w) => index.nameWords.has(w))) return false;
  return true;
}

/** How many modules have a test file named after them, among modules whose names are distinctive enough to judge. Go and Rust organise tests differently and are not counted. */
export function perModuleShare(sources: Pick<FileEntry, "path">[], index: TestIndex): { named: number; eligible: number } {
  let named = 0;
  let eligible = 0;
  for (const f of sources) {
    if (/\.(go|rs|h|hpp|hh|hxx)$/.test(f.path)) continue;
    const stem = sourceStem(f.path);
    if (stem.length < 4 || GENERIC_STEMS.has(stem)) continue;
    eligible++;
    const words = stemWords(basename(f.path).replace(/\.[^.]+$/, ""));
    if (index.stems.has(stem) || words.some((w) => index.nameWords.has(w))) named++;
  }
  return { named, eligible };
}

export interface SkippedTest {
  path: string;
  line: number;
  text: string;
  reason: string | undefined;
}

const SKIP_PATTERNS = [
  /@pytest\.mark\.skip\b/, /@pytest\.mark\.xfail\b/, /@unittest\.skip\b/, /\bpytest\.skip\(/, /\bpytest\.xfail\(/,
  /\b(it|test|describe)\.skip\(/, /\bx(it|describe|test)\(/, /\b(it|test)\.todo\(/,
  /\bt\.Skip(f|Now)?\(/, /#\[ignore\b/, /\bskip:\s*true\b/, /\b(xit|xspecify|xcontext)\b/, /\bpending\(/,
];
const INTENTIONAL = /platform|win32|darwin|linux|windows|macos|\bCI\b|\bslow\b|\bshort\b|network|internet|docker|requires?|not (installed|available|supported|implemented)|unsupported|optional|credentials?|api[_ ]?key|token|gpu|cuda|py(thon)?\s*[<>=]|version|only on|integration|manual|benchmark|external|hardware|display|headless|skipping in|race detector|32-?bit|big.?endian/i;

export function findSkippedTests(path: string, text: string): SkippedTest[] {
  const out: SkippedTest[] = [];
  const lines = text.split("\n");
  // A skip marker quoted inside a string (a test tool's own fixture) is not a skipped test.
  const masked = maskCodeLiterals(text, maskLangFor(path)).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!SKIP_PATTERNS.some((p) => p.test(masked[i] ?? ""))) continue;
    const window = [line, lines[i + 1] ?? "", lines[i - 1] ?? ""].join(" ");
    const reason = /reason\s*=\s*["'`]([^"'`]+)["'`]/.exec(window)?.[1] ?? /skip(?:If|Unless|f)?\([^"'`]*["'`]([^"'`]+)["'`]/.exec(window)?.[1] ?? /\.skip\(\s*["'`]([^"'`]+)["'`]/.exec(window)?.[1] ?? /\bt\.Skip(?:f|Now)?\(\s*"([^"]+)"/.exec(line)?.[1];
    // Conditional skips (if ...: skip / if testing.Short() { t.Skip }) are deliberate, not forgotten.
    const previous = lines[i - 1] ?? "";
    const conditional = /skipif|skipIf|skipUnless|\.skipIf\(|skip_if|xfail\(.*condition|\bif\b/.test(line) || (/^\s*if\b.*[{:]\s*$/.test(previous));
    if (conditional && !/TODO|FIXME|flaky|broken/i.test(window)) continue;
    if (reason && INTENTIONAL.test(reason) && !/TODO|FIXME|flaky|broken|fails|temporar|until|#\d+/i.test(reason)) continue;
    out.push({ path, line: i + 1, text: line.trim(), reason });
  }
  return out;
}

export const testGapsAnalyzer: Analyzer = {
  name: "test-gaps",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (!["library", "cli", "framework", "application", "plugin", "unknown"].includes(profile.nature)) return [];
    const files = ctx.inventory.files.filter((f) => !f.vendored);
    const tests = files.filter((f) => f.category === "test" && f.language && CODE_LANGS.has(f.language));
    const sources = files.filter((f) => f.category === "source" && f.language && CODE_LANGS.has(f.language) && !NOT_WORTH_TESTING.test(f.path));
    const findings: Finding[] = [];
    const testCommand = profile.ecosystems.find((e) => e.commands.test)?.commands.test;

    if (tests.length === 0) {
      if (sources.length >= 5 && ["library", "cli", "framework"].includes(profile.nature)) {
        findings.push({
          kind: "test_gap",
          clusterKey: "no-tests",
          title: "Add an initial automated test suite",
          summary: `The repository has ${sources.length} source files and no test files, so every change is verified by hand.`,
          evidence: [evidence(ctx, "computed", "file inventory", { note: `${sources.length} source files, 0 test files matched test naming conventions` })],
          files: profile.hotFiles.slice(0, 5).map((h) => h.path),
          effort: "large",
          skills: [...new Set(sources.map((s) => s.language!.toLowerCase()))].slice(0, 2),
          approach: ["Propose the test framework in an issue first and agree on scope.", "Start with the most frequently changed modules and the public entry points.", "Wire the suite into CI once it exists."],
          acceptanceCriteria: ["A test command runs locally and in CI.", "Core public behaviour has at least smoke coverage."],
          etiquette: ["Discuss before writing; maintainers often have strong views on test tooling."],
          risks: ["Maintainers may prefer to design testing themselves, or may not want the maintenance burden."],
          signals: { value: 0.6, valueReason: "a project with users and no tests regresses silently", feasibility: 0.5, feasibilityReason: "needs understanding of the whole codebase and a framework decision", confidence: 0.85, confidenceReason: "no file matched any common test naming convention", welcomenessFactor: 0.7, welcomenessReason: "large unsolicited additions need buy-in" },
        });
      }
      return findings;
    }

    // Index tests (names and contents) to see which sources they mention. Data-driven suites
    // (.test, .txt, .sh, .json fixtures) count too: they often name the module under test.
    const BINARY = /\.(png|jpe?g|gif|tiff?|bmp|ico|webp|avif|pdf|ttf|otf|woff2?|bin|dat|zip|gz|tar|wasm|mp[34]|wav|ogg|mov|psd|eps|svgz|pyc|class|jar|so|dylib|dll|exe)$/i;
    const allTestFiles = files.filter((f) => f.category === "test" && f.sizeBytes <= 200 * 1024 && !BINARY.test(f.path));
    // Names and directories come from every test path (cheap). Contents: code tests first, then data files, 400 in all;
    // git grep confirms every candidate so a partial index can only produce misses, never false claims.
    const ordered = [...allTestFiles].sort((a, b) => Number(Boolean(b.language && CODE_LANGS.has(b.language))) - Number(Boolean(a.language && CODE_LANGS.has(a.language))));
    const testTexts: { path: string; text: string | undefined }[] = ordered.map((t) => ({ path: t.path, text: undefined }));
    for (const t of testTexts.slice(0, 400)) t.text = await ctx.read(t.path, 200 * 1024);
    const index = buildTestIndex(testTexts);

    const churn = new Map<string, { commits: number; authors: Set<string> }>();
    for (const c of ctx.commits) for (const f of c.files) {
      const s = churn.get(f) ?? { commits: 0, authors: new Set<string>() };
      s.commits++;
      s.authors.add(c.authorEmail);
      churn.set(f, s);
    }
    // C and C++ suites are often data-driven (jq's .test files, shell scripts); only judge them when C/C++ unit tests exist.
    // Fuzz harnesses (jq's tests/jq_fuzz_*.c) are C files under tests/ but not unit tests.
    const hasCUnitTests = tests.some((t) => (t.language === "C" || t.language === "C++") && !/fuzz/i.test(t.path));
    const candidates = sources
      .filter((f) => hasCUnitTests || (f.language !== "C" && f.language !== "C++"))
      .filter((f) => ![".h", ".hpp", ".hh", ".hxx"].includes(f.ext)) // headers declare; tests target the implementation
      .filter((f) => f.sizeBytes >= 1500 && (churn.get(f.path)?.commits ?? 0) >= 3)
      .sort((a, b) => (churn.get(b.path)!.commits * Math.log(b.sizeBytes)) - (churn.get(a.path)!.commits * Math.log(a.sizeBytes)))
      .slice(0, 40);

    const testPaths = profile.structure.testDirs.length ? profile.structure.testDirs : tests.map((t) => t.path).slice(0, 200);
    // Snapshot-driven suites (prettier's jsfmt.spec.js over thousands of .snap files) never name the modules they cover.
    // Snapshots are flagged vendored in the inventory, so count them from the full file list.
    const snapshotFiles = ctx.inventory.files.filter((f) => /\.snap$|(^|\/)__snapshots__\//.test(f.path)).length;
    // Compare against spec files by name; everything else under tests/ is fixtures and inputs.
    const specFiles = tests.filter((t) => isTestSpecFile(t.path)).length;
    const snapshotDriven = snapshotFiles >= 50 && snapshotFiles >= Math.max(1, specFiles) * 0.5;
    if (snapshotDriven) ctx.budget.note(`test suite is snapshot-driven (${snapshotFiles} snapshot files); untested-file heuristics skipped`);
    // "Add tests for X" presumes a suite organised by module. When almost no module has a test named after it,
    // the suite is end-to-end or data-driven, and a per-file gap is not a gap.
    const convention = perModuleShare(sources, index);
    const perModule = convention.eligible < 10 || convention.named / convention.eligible >= 0.1;
    if (!perModule && !snapshotDriven) ctx.budget.note(`tests are not organised by module (${convention.named} of ${convention.eligible} modules have a test named after them); untested-file heuristics skipped`);
    let emitted = 0;
    for (const file of snapshotDriven || !perModule ? [] : candidates) {
      if (emitted >= 5) break;
      const text = await ctx.read(file.path);
      if (!text || text.split("\n").length < 60) continue;
      if (!looksUntested(file.path, text, index)) continue;
      // The in-memory index covers at most 400 test files; git grep sees every tracked test file.
      if (await mentionedInTests(ctx, sourceStem(file.path), testPaths)) continue;
      const c = churn.get(file.path)!;
      emitted++;
      findings.push(untestedFinding(ctx, file, c.commits, c.authors.size, testCommand, profile));
    }

    const skipped: SkippedTest[] = [];
    // A test framework's own suite uses skip and pending markers as the thing under test.
    const isTestFramework = /\b(mocha|jest|vitest|pytest|ava|tape?|jasmine|karma|cypress|playwright|nose|unittest|testing framework|test runner)\b/i.test(`${ctx.meta.name} ${ctx.meta.description ?? ""}`);
    if (isTestFramework) return findings;
    const fixture = /(^|\/)(fixtures?|testdata|__snapshots__|snapshots?)(\/|$)/i;
    for await (const { path, text } of textFiles(ctx, (p) => !fixture.test(p) && tests.some((t) => t.path === p), 400)) skipped.push(...findSkippedTests(path, text));
    for (const s of skipped.slice(0, 30)) {
      findings.push({
        kind: "test_gap",
        clusterKey: "skipped-tests",
        title: "Investigate and re-enable skipped or expected-failure tests",
        summary: "Tests are skipped or marked as expected failures without a platform or environment reason, which usually means a known bug nobody has gone back to.",
        evidence: [evidence(ctx, "file", `${s.path}:${s.line}`, { excerpt: s.text, note: s.reason ? `reason given: ${s.reason}` : "no reason given" })],
        files: [s.path],
        effort: "small",
        skills: [ctx.inventory.byPath.get(s.path)?.language?.toLowerCase() ?? "testing"],
        approach: ["Run the skipped test locally and read the failure.", "Fix the underlying bug or, if the test is obsolete, delete it with an explanation.", "Reference any issue the skip mentions."],
        acceptanceCriteria: ["The test runs and passes in CI, or is removed with a justification maintainers accept."],
        risks: ["The skip may hide a hard problem; time-box the investigation."],
        signals: { value: 0.45, valueReason: "a disabled test often marks a real bug", feasibility: 0.6, feasibilityReason: "failure is reproducible by removing the skip", confidence: 0.8, confidenceReason: "skip marker verified in the test source; whether it is fixable is not", welcomenessFactor: 0.9 },
      });
    }
    return findings;
  },
};

/** True when any tracked test file mentions the stem as a whole word (case-insensitive). */
async function mentionedInTests(ctx: AnalysisContext, stem: string, testPaths: string[]): Promise<boolean> {
  try {
    const out = await ctx.repo.grep(stem, testPaths);
    return out.length > 0;
  } catch {
    return false;
  }
}

function untestedFinding(ctx: AnalysisContext, file: FileEntry, commits: number, authors: number, testCommand: string | undefined, profile: RepositoryProfile): Finding {
  const lang = file.language ?? extname(file.path);
  const central = (profile.structure.centralFiles ?? []).find((c) => c.path === file.path || file.path.startsWith(`${c.path}/`));
  return {
    kind: "test_gap",
    clusterKey: `untested:${file.path}`,
    title: `Add tests for ${file.path}`,
    summary: `${file.path} changed in ${commits} commits by ${authors} author${authors === 1 ? "" : "s"} over the last year${central ? `, is imported by ${central.importedBy} other modules` : ""}, and no test file names or references it.`,
    evidence: [
      evidence(ctx, "computed", `git log --since=365d -- ${file.path}`, { note: `${commits} commits, ${authors} authors` }),
      evidence(ctx, "computed", `test index (${profile.structure.testDirs.join(", ") || "test files"})`, { note: `no test file named after or mentioning "${sourceStem(file.path)}"` }),
    ],
    files: [file.path, ...profile.structure.testDirs.slice(0, 1)],
    effort: "medium",
    skills: [lang.toLowerCase(), "testing"],
    approach: [
      `Read ${file.path} and list its public functions and the branches that changed most recently (git log -p).`,
      `Add a test module following the existing layout in ${profile.structure.testDirs[0] ?? "the test directory"}${profile.conventions.testFramework ? ` using ${profile.conventions.testFramework}` : ""}.`,
      testCommand ? `Run ${testCommand} and keep the new tests fast and deterministic.` : "Run the project's test command and keep new tests fast and deterministic.",
    ],
    acceptanceCriteria: ["New tests exercise the main code paths of the module and pass in CI.", "No production code changes are needed except to enable testing."],
    risks: ["The module may be covered indirectly by integration tests under a different name."],
    signals: {
      // Backtest (29 repos, 365 days): none of the flagged untested files gained a test, so this prior sits below
      // deprecations and broken links unless the file is hot and central.
      value: Math.min(0.7, 0.35 + commits * 0.02 + (central ? 0.1 : 0)) * (file.language === "C" || file.language === "C++" ? 0.7 : 1),
      valueReason: `hot code (${commits} commits/year${central ? `, imported by ${central.importedBy} modules` : ""}) with no direct tests is where regressions come from; maintainers rarely add tests unprompted`,
      feasibility: profile.conventions.testFramework ? 0.7 : 0.55,
      feasibilityReason: profile.conventions.testFramework ? `test framework (${profile.conventions.testFramework}) and layout already exist` : "test framework not identified; follow the existing tests",
      confidence: file.language === "C" || file.language === "C++" ? 0.4 : file.ext === ".rs" ? 0.45 : 0.6,
      confidenceReason: file.ext === ".rs" || file.language === "C" || file.language === "C++" ? "tests in this language often live in integration or data-driven suites that never name the module; naming heuristics are weak here" : "based on naming conventions and test-source mentions, not coverage data",
      welcomenessFactor: 0.95,
      welcomenessReason: "tests are rarely refused",
    },
  };
}
