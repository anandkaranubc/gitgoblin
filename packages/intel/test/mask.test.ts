import { describe, expect, it } from "vitest";
import { matchDeprecations } from "../src/analyzers/deprecations.ts";
import { DEPRECATION_RULES } from "../src/analyzers/deprecation-rules.ts";
import { findSkippedTests } from "../src/analyzers/test-gaps.ts";
import { findDebtMarkers } from "../src/analyzers/tech-debt.ts";
import { maskCodeLiterals } from "../src/util/mask.ts";

describe("maskCodeLiterals", () => {
  it("blanks strings, template literals, comments and regex literals in JavaScript, keeping length", () => {
    const src = 'const a = "url.parse(x)"; // url.parse(y)\nconst r = /\\burl\\.parse\\(/;\nconst t = `line1\nurl.parse(z)\n`; url.parse(real);';
    const masked = maskCodeLiterals(src, "js");
    expect(masked.length).toBe(src.length);
    expect(masked).not.toMatch(/url\.parse\((x|y|z)\)/);
    expect(masked).toMatch(/url\.parse\(real\)/);
    expect(masked).not.toMatch(/\\burl/);
  });

  it("blanks Python strings, triple-quoted strings and comments", () => {
    const src = 'x = "import imp"\ny = """\nimport imp\n"""\n# import imp\nimport imp\n';
    const masked = maskCodeLiterals(src, "py");
    expect(masked.split("\n").filter((l) => /import imp/.test(l))).toHaveLength(1);
  });
});

describe("maskCodeLiterals edge cases", () => {
  it("knows Go raw strings have no escapes", () => {
    const src = "p := `C:\\Users\\`\nt.Skip(\"x\")\n";
    expect(maskCodeLiterals(src, "go")).toMatch(/t\.Skip\(/);
  });

  it("honours escapes inside Python triple-quoted strings", () => {
    const src = 'x = """a \\""" b"""\nimport imp\n';
    expect(maskCodeLiterals(src, "py")).toMatch(/^import imp$/m);
  });

  it("scans template expressions as code, including nested templates and quotes", () => {
    const src = "const s = `a ${foo('b`c')} d`; url.parse(x);\nconst t = `${items.map(i => `<li>${i}</li>`)}`; fs.exists(p);\n";
    const masked = maskCodeLiterals(src, "js");
    expect(masked).toMatch(/url\.parse\(x\)/);
    expect(masked).toMatch(/fs\.exists\(p\)/);
    expect(masked).not.toMatch(/<li>/);
    expect(masked.length).toBe(src.length);
  });

  it("treats a regex after an arrow as a literal", () => {
    expect(maskCodeLiterals("const f = x => /url\\.parse/.test(x);", "js")).not.toMatch(/url/);
  });

  it("knows slash comments in C-family files and leaves unknown languages alone", () => {
    expect(findDebtMarkers("Foo.java", "// TODO: don't forget #123\n").map((m) => m.issues)).toEqual([[123]]);
    expect(findDebtMarkers("foo.c", "/* TODO: it's broken, see #42 */\n").map((m) => m.text)).toEqual(["it's broken, see #42"]);
    expect(maskCodeLiterals("it's 'raw' text", "other")).toBe("it's 'raw' text");
  });
});

describe("analyzers ignore quoted patterns", () => {
  it("does not flag a deprecated API named in a rule table, string or comment", () => {
    const rules = DEPRECATION_RULES.filter((r) => r.ecosystem === "node");
    const table = 'export const RULES = [\n  { pattern: /\\burl\\.parse\\(/, title: "Replace url.parse()" },\n  { pattern: /\\bnew Buffer\\(/, detail: "new Buffer( is deprecated" },\n];\n// fs.exists( is gone\nconst b = new Buffer(1);\n';
    expect(matchDeprecations("rules.ts", table, rules).map((m) => `${m.rule.id}@${m.line}`)).toEqual(["node-buffer@6"]);
  });

  it("does not count a skip marker quoted in a test fixture", () => {
    const fixture = 'const js = "it.skip(\'does thing\', () => {});";\nit.skip("real", () => {});\n';
    expect(findSkippedTests("a.test.js", fixture).map((s) => s.line)).toEqual([2]);
  });

  it("does not read a TODO inside a string as debt, but keeps TODOs in comments", () => {
    const src = 'raise ValueError("TODO: implement this later please")  # TODO: real debt here\n';
    const markers = findDebtMarkers("a.py", src);
    expect(markers.map((m) => m.text)).toEqual(["real debt here"]);
  });
});
