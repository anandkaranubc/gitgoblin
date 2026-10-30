import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { normalizeName } from "../manifests/python.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

export interface CodeBlock {
  path: string;
  line: number;
  lang: string;
  code: string;
}

export function codeBlocks(path: string, markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split("\n");
  let open: { line: number; lang: string; buf: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence && !open) open = { line: i + 1, lang: fence[2]!.toLowerCase(), buf: [] };
    else if (fence && open) {
      blocks.push({ path, line: open.line, lang: open.lang, code: open.buf.join("\n") });
      open = undefined;
    } else if (open) open.buf.push(line);
  }
  return blocks;
}

/** `from pkg.sub import A, B` and `import pkg.sub` in README code; returns [module, name][]. */
export function pythonImports(code: string): { module: string; name: string | undefined; line: number }[] {
  const out: { module: string; name: string | undefined; line: number }[] = [];
  code.split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s*(>>>|\.\.\.)\s?/, "");
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (from) {
      for (const part of from[2]!.replace(/[()]/g, "").split(",")) {
        const name = part.trim().split(/[ \t]{1,20}as[ \t]{1,20}/)[0]!.trim();
        if (name && name !== "*") out.push({ module: from[1]!, name, line: i + 1 });
      }
      return;
    }
    const plain = /^\s*import\s+([\w.]+)/.exec(line);
    if (plain) out.push({ module: plain[1]!, name: undefined, line: i + 1 });
  });
  return out;
}

/** Named imports of a package in README JS/TS code: import { A } from "pkg"; const { A } = require("pkg"). */
export function jsNamedImports(code: string, pkg: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`import\\s*\\{([^}]{1,1000})\\}\\s*from\\s*["'\`]${esc}(?:/[^"'\`]*)?["'\`]|(?:const|let|var)\\s*\\{([^}]{1,1000})\\}\\s*=\\s*require\\(\\s*["'\`]${esc}["'\`]\\s*\\)`, "g");
  code.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      for (const part of (m[1] ?? m[2] ?? "").split(",")) {
        const name = part.trim().split(/[ \t]{1,20}as[ \t]{1,20}|[ \t]{0,20}:[ \t]{0,20}/)[0]!.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default" && name !== "type") out.push({ name, line: i + 1 });
      }
    }
  });
  return out;
}

/**
 * Whether Python source defines, imports or lists `name` in `__all__`. Each form is anchored at a
 * line start and spans horizontal whitespace only: `^\s*` crossed blank lines, so a long run of them
 * was rescanned from every line start, and an unanchored `import`/`__all__` rescanned the rest of
 * its line from every occurrence.
 */
export function pythonDefines(source: string, name: string): boolean {
  return new RegExp(`^[ \\t]*(?:async[ \\t]+)?(?:def|class)[ \\t]+${name}\\b|^[ \\t]*${name}[ \\t]*(?::[^=\\n]+)?=|^[ \\t]*(?:from[ \\t]+[\\w.]+[ \\t]+)?import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*)*${name}\\b|^[ \\t]*(?:from[ \\t]+[\\w.]+[ \\t]+)?import[ \\t][^\\n]*\\bas[ \\t]+${name}\\b|^[ \\t]*__all__[^\\n]*["']${name}["']`, "m").test(source);
}

/**
 * Whether JS/TS source exports `name`. Brace lists (`export { a, b }`, `module.exports = { a }`)
 * are read in one forward pass: `export\s*\{[^}]*\bname\b` rescanned to the end of the source
 * from every brace that never closes.
 */
export function jsExports(source: string, name: string): boolean {
  if (new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|type|interface|enum|abstract class)\\s+${name}\\b|exports\\.${name}\\s*=|\\b${name}\\s*[,}]\\s*(?:=\\s*)?(?:module\\.)?exports|export\\s*\\*\\s*from`).test(source)) return true;
  const listed = new RegExp(`\\b${name}\\b`);
  for (const m of source.matchAll(/(?:export|module\.exports\s*=)\s*\{([^}]*)/g)) if (listed.test(m[1]!)) return true;
  return false;
}

export function cliFlagsInDocs(code: string, commands: string[]): { flag: string; line: number }[] {
  const out: { flag: string; line: number }[] = [];
  const names = commands.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return out;
  const starts = new RegExp(`^\\s*(\\$\\s*)?(?:(?:npx|uvx|pipx run|poetry run|python -m|node|cargo run --\\s*)\\s+)?(?:${names.join("|")})\\b`);
  code.split("\n").forEach((line, i) => {
    if (!starts.test(line)) return;
    const beforeSeparator = line.split(/\s--(\s|$)/)[0]!;
    for (const m of beforeSeparator.matchAll(/(?<=\s)--([a-zA-Z][\w-]*)/g)) {
      const flag = m[1]!;
      if (!/^(help|version|verbose|quiet|debug)$/.test(flag)) out.push({ flag, line: i + 1 });
    }
  });
  return out;
}

const FLAG_DEFINITIONS = [
  /add_argument\(\s*(?:["'][^"']+["']\s*,\s*)*["']--([a-zA-Z][\w-]*)["']/g, // argparse, any number of short aliases first
  /(?:click|typer|app|cli|group|command)\.(?:option|argument)\(\s*(?:["'][^"']+["']\s*,\s*)*["']--([a-zA-Z][\w-]*)(?:[ \t]*\/[ \t]*--([a-zA-Z][\w-]*))?/g, // click, decorator or assigned, flag on any line; "--x/--no-x" defines both
  /\.(?:option|requiredOption)\(\s*["'](?:-\w,\s*)?--([a-zA-Z][\w-]*)/g, // commander
  /\.(?:option|options)\(\s*["']([a-zA-Z][\w-]*)["']/g, // yargs
  /Flags\(\)\.\w+(?:VarP?|P)?\([^,]{0,200},\s*"([a-zA-Z][\w-]*)"/g, // cobra/pflag (name is 2nd arg for Var forms)
  /flag\.\w+\(\s*"([a-zA-Z][\w-]*)"/g, // Go flag
  /long\s*=\s*"([a-zA-Z][\w-]*)"/g, // clap explicit
  /\.long\(\s*"([a-zA-Z][\w-]*)"\s*\)/g, // clap builder
  /\.arg\(\s*["']--([a-zA-Z][\w-]*)/g, // misc
];

export function cliFlagsInCode(text: string): Set<string> {
  const flags = new Set<string>();
  for (const re of FLAG_DEFINITIONS) for (const m of text.matchAll(re)) for (const f of m.slice(1)) if (f) flags.add(f.toLowerCase().replace(/_/g, "-"));
  // argparse's BooleanOptionalAction adds --no-<name> beside --<name>.
  for (const m of text.matchAll(/add_argument\(\s*(?:["'][^"']+["']\s*,\s*)*["']--([a-zA-Z][\w-]*)["'][^)]{0,300}?BooleanOptionalAction/g)) flags.add(`no-${m[1]!.toLowerCase().replace(/_/g, "-")}`);
  // clap derive: `#[arg(long)]` followed by a field name.
  for (const m of text.matchAll(/#\[(?:arg|clap)\([^)\n]{0,200}\blong\b[^)\n]{0,200}\)\][ \t\r\n]{0,200}(?:pub[ \t]+)?(\w+)[ \t]*:/g)) flags.add(m[1]!.toLowerCase().replace(/_/g, "-"));
  return flags;
}

/** Package install commands shown in a README (pip, npm, cargo, go and friends), with the package named. */
export function installCommands(readme: string): { tool: string; name: string; index: number }[] {
  // The value of -r, -c and -e (a requirements file, a constraints file, a path or URL) is not a package name.
  return [...readme.matchAll(/\b(pip|pip3|uv pip|pipx|uv tool|npm|pnpm|yarn|bun|cargo|go)[ \t]{1,10}(?:install|add|get)[ \t]{1,10}(?:-(?![rce][ \t]|-(?:requirement|constraint|editable)\b)[-\w]{0,40}[ \t]{1,10}){0,10}([@\w][\w./@-]{0,200})/g)].filter((m) => !/\.txt$/i.test(m[2]!)).map((m) => ({ tool: m[1]!, name: m[2]!.replace(/\[.*$/, "").replace(/[@=<>~^].*$/, (s) => (s.startsWith("@") && m[2]!.startsWith("@") ? s : "")) , index: m.index! }));
}

export const docsDriftAnalyzer: Analyzer = {
  name: "docs-drift",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (!["library", "cli", "framework", "plugin", "application", "unknown"].includes(profile.nature)) return [];
    const readmePath = ctx.inventory.files.find((f) => /^readme\.(md|markdown|rst)$/i.test(f.path))?.path;
    if (!readmePath) return [];
    const readme = await ctx.read(readmePath);
    if (!readme) return [];
    const blocks = codeBlocks(readmePath, readme);
    const findings: Finding[] = [];
    const { python, node } = ctx.manifests;

    // Python: names imported from the package in README examples must exist in its source.
    if (python && python.packageDirs.length > 0) {
      const packageNames = new Set(python.packageDirs.map((d) => d.split("/").pop()!));
      const wanted = blocks.filter((b) => /^(py|python|pycon|python3|)$/.test(b.lang)).flatMap((b) => pythonImports(b.code).map((imp) => ({ ...imp, blockLine: b.line })));
      const relevant = wanted.filter((w) => packageNames.has(w.module.split(".")[0]!) && w.name && /^[A-Za-z_]\w*$/.test(w.name));
      if (relevant.length > 0) {
        const corpus: string[] = [];
        for await (const { text } of textFiles(ctx, (p) => python.packageDirs.some((d) => p.startsWith(`${d}/`)) && p.endsWith(".py"), 800)) corpus.push(text);
        const joined = corpus.join("\n");
        const defined = (name: string, module: string): boolean => {
          if (pythonDefines(joined, name)) return true;
          // A submodule import: `from pkg import sub` where sub is a file or directory.
          const sub = `${module.replace(/\./g, "/")}/${name}`;
          return ctx.inventory.files.some((f) => f.path.endsWith(`${sub}.py`) || f.path.includes(`${sub}/__init__.py`));
        };
        for (const w of relevant) {
          if (defined(w.name!, w.module)) continue;
          findings.push(driftFinding(ctx, readmePath, w.blockLine + w.line, `from ${w.module} import ${w.name}`, `${w.name} is not defined or re-exported anywhere under ${python.packageDirs.join(", ")}`, "readme-imports", "python", 0.7));
        }
      }
    }

    // Node: named imports of the package in README examples must be exported from source.
    if (node?.name && !node.private) {
      const wanted = blocks.filter((b) => /^(js|javascript|ts|typescript|jsx|tsx|mjs|cjs|)$/.test(b.lang)).flatMap((b) => jsNamedImports(b.code, node.name!).map((imp) => ({ ...imp, blockLine: b.line })));
      if (wanted.length > 0) {
        const corpus: string[] = [];
        for await (const { text } of textFiles(ctx, (p) => /\.[cm]?[jt]sx?$/.test(p) && ctx.inventory.byPath.get(p)?.category === "source" && !/\.d\.ts$/.test(p), 800)) corpus.push(text);
        const joined = corpus.join("\n");
        for (const w of wanted) {
          if (jsExports(joined, w.name)) continue;
          findings.push(driftFinding(ctx, readmePath, w.blockLine + w.line, `import { ${w.name} } from "${node.name}"`, `nothing in the source exports ${w.name}`, "readme-imports", "node", 0.65));
        }
      }
    }

    // CLI flags shown in README must be defined somewhere in the code.
    const commandNames = [
      ...(python?.scripts.filter((s) => !s.startsWith("(")) ?? []),
      ...(node?.hasBin ? [node.name ?? ""].filter(Boolean) : []),
      ...(ctx.manifests.rust?.hasBin && ctx.manifests.rust.name ? [ctx.manifests.rust.name] : []),
      ...(ctx.manifests.go?.hasMainPackage && ctx.manifests.go.module ? [ctx.manifests.go.module.split("/").pop()!] : []),
    ].filter((c) => c.length >= 2);
    const docFlags = blocks.filter((b) => /^(sh|bash|shell|console|zsh|text|)$/.test(b.lang)).flatMap((b) => cliFlagsInDocs(b.code, commandNames).map((f) => ({ ...f, blockLine: b.line })));
    if (docFlags.length > 0) {
      const defined = new Set<string>();
      for await (const { text } of textFiles(ctx, (p) => ctx.inventory.byPath.get(p)?.category === "source", 1500)) for (const f of cliFlagsInCode(text)) defined.add(f);
      if (defined.size >= 3) {
        for (const f of docFlags) {
          const norm = f.flag.toLowerCase().replace(/_/g, "-");
          if (defined.has(norm) || [...defined].some((d) => d.startsWith(norm) || norm.startsWith(d))) continue;
          findings.push(driftFinding(ctx, readmePath, f.blockLine + f.line, `--${f.flag}`, `no flag definition for --${f.flag} found among ${defined.size} flags defined in the code`, "readme-flags", "cli", 0.65));
        }
      }
    }

    // Install command names the wrong distribution.
    const installs = installCommands(readme);
    // Only complain when no install command names the package itself.
    const namesThisPackage = installs.some((ins) => (python?.name && normalizeName(ins.name) === normalizeName(python.name)) || (node?.name && ins.name === node.name));
    for (const ins of namesThisPackage ? [] : installs) {
      if (/^(\.|-|https?:|git\+)/.test(ins.name) || ins.name.length < 2) continue;
      let mismatch: string | undefined;
      if (/^pip|^uv|^pipx/.test(ins.tool) && python?.name && normalizeName(ins.name) !== normalizeName(python.name) && !python.dependencies.some((d) => d.name === normalizeName(ins.name)) && !/^(pytest|tox|nox|pre-commit|poetry|uv|pdm|hatch|build|twine|setuptools|wheel|pip|virtualenv|ruff|black|mypy)$/.test(normalizeName(ins.name))) {
        mismatch = `pyproject/setup names the distribution "${python.name}"`;
      }
      if (/^(npm|pnpm|yarn|bun)$/.test(ins.tool) && node?.name && !node.private && ins.name !== node.name && !node.dependencies.some((d) => d.name === ins.name) && !/^(-g|--global|-D|--save-dev|typescript|eslint|prettier|vitest|jest|ts-node|tsx|nodemon|npm|pnpm|yarn|bun|vercel|serve|http-server|@types\/)/.test(ins.name)) {
        mismatch = `package.json names the package "${node.name}"`;
      }
      if (!mismatch) continue;
      const line = readme.slice(0, ins.index).split("\n").length;
      findings.push(driftFinding(ctx, readmePath, line, `${ins.tool} install ${ins.name}`, mismatch, "readme-install", "docs", 0.5));
    }
    return findings;
  },
};

function driftFinding(ctx: AnalysisContext, readmePath: string, line: number, excerpt: string, why: string, cluster: string, skill: string, confidence: number): Finding {
  const what = cluster === "readme-imports" ? "imports" : cluster === "readme-flags" ? "command-line flags" : "install commands";
  return {
    kind: "docs_drift",
    clusterKey: cluster,
    title: `README ${what} do not match the code`,
    summary: `Examples in ${readmePath} reference ${what} the code does not define, so the first thing a new user tries fails.`,
    evidence: [evidence(ctx, "file", `${readmePath}:${line}`, { excerpt, note: why })],
    files: [readmePath],
    effort: "trivial",
    skills: ["docs", skill],
    approach: ["Run the README example exactly as written against a fresh install to confirm it fails.", "Update the example to the current API or flag name (check git log for the rename).", "Mention the failing command in the PR so maintainers can verify quickly."],
    acceptanceCriteria: ["Every code example in the README runs against the current release or default branch."],
    risks: ["The name may be generated dynamically or re-exported in a way the search missed; verify by running it."],
    signals: {
      value: 0.5,
      valueReason: "README examples are the first thing every new user runs",
      feasibility: 0.9,
      feasibilityReason: "small edit once the correct name is confirmed",
      confidence,
      confidenceReason: "static cross-reference of README code against source; dynamic exports can hide",
      welcomenessFactor: 0.95,
      welcomenessReason: "fixing a wrong example is rarely refused",
    },
  };
}
