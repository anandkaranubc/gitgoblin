import { describe, expect, it } from "vitest";
import { DEPRECATION_RULES } from "../src/analyzers/deprecation-rules.ts";
import { matchDeprecations, pythonRange, ruleApplies } from "../src/analyzers/deprecations.ts";
import { findDebtMarkers, minimumPython, pythonVersionConditionMet } from "../src/analyzers/tech-debt.ts";

describe("tech debt markers", () => {
  it("finds TODO-style markers in comments and extracts issue numbers", () => {
    const src = `
x = 1  # TODO(#42): remove once the parser handles this
// FIXME: this breaks on Windows, see https://github.com/o/r/issues/7
const todo = "TODO not a comment";
def todo_list(): pass
/* HACK: temporary until GH-99 lands */
`;
    const markers = findDebtMarkers("a.py", src);
    expect(markers.map((m) => [m.marker, m.issues])).toEqual([["TODO", [42]], ["FIXME", [7]], ["HACK", [99]]]);
    expect(findDebtMarkers("rule.rs", "/// ## Example\n/// ```python\n/// # TODO(charlie): fix this (#123)\n/// ```\n// TODO: real debt here\n")).toHaveLength(1);
    expect(markers[0]?.text).toBe("remove once the parser handles this");
  });

  it("recognises Python-version conditions that are already met", () => {
    expect(minimumPython(">=3.9", [])).toBe("3.9");
    expect(minimumPython("^3.8", [])).toBe("3.8");
    expect(minimumPython(undefined, ["3.7", "3.8"])).toBe("3.7");
    expect(pythonVersionConditionMet("remove when we drop python 3.7", "3.9")).toBe("3.7");
    expect(pythonVersionConditionMet("remove when we drop 3.10", "3.9")).toBeUndefined();
    expect(pythonVersionConditionMet("uses 3.8 style typing", "3.9")).toBeUndefined();
    expect(pythonVersionConditionMet("remove after 3.0 is released", "3.9")).toBeUndefined();
    expect(pythonVersionConditionMet("drop this once we require py38", "3.9")).toBe("3.8");
  });
});

describe("deprecation rules", () => {
  it("gates removed-API rules on the Python range the project claims", () => {
    const imp = DEPRECATION_RULES.find((r) => r.id === "py-imp")!;
    expect(ruleApplies(imp, pythonRange(">=3.8", []))).toBe(true);
    expect(ruleApplies(imp, pythonRange(">=3.8,<3.12", []))).toBe(false);
    expect(pythonRange(">=3.8,<3.12", []).max).toBe("3.11");
  });

  it("matches usages, skips comments, and marks guarded shims", () => {
    const src = `
import imp  # legacy
# import imp
try:
    from collections import Mapping
except ImportError:
    from collections.abc import Mapping
now = datetime.utcnow()
x = collections.Mapping
`;
    const rules = DEPRECATION_RULES.filter((r) => r.ecosystem === "python");
    const matches = matchDeprecations("a.py", src, rules).map((m) => `${m.rule.id}@${m.line}${m.guarded ? "!" : ""}`);
    expect(matches).toEqual(["py-imp@2", "py-utcnow@8", "py-collections-abc@9"]);
  });

  it("matches node and go patterns", () => {
    const node = matchDeprecations("a.js", "const b = new Buffer('x');\nconst u = url.parse(s);\n", DEPRECATION_RULES.filter((r) => r.ecosystem === "node"));
    expect(node.map((m) => m.rule.id)).toEqual(["node-buffer", "node-url-parse"]);
    const go = matchDeprecations("a.go", 'import (\n\t"io/ioutil"\n\t"os"\n)\n', DEPRECATION_RULES.filter((r) => r.ecosystem === "go"));
    expect(go.map((m) => m.rule.id)).toEqual(["go-ioutil"]);
  });
});

describe("deprecation matches that a project already handles", () => {
  it("marks function-local imports of removed modules as guarded", () => {
    const rules = DEPRECATION_RULES.filter((r) => r.ecosystem === "python");
    const text = "import sysconfig\n\ndef _scheme():\n    from distutils.command.install import INSTALL_SCHEMES\n    return INSTALL_SCHEMES\n\nfrom distutils.dist import Distribution\n";
    expect(matchDeprecations("a.py", text, rules).map((m) => `${m.line}:${m.guarded}`)).toEqual(["4:true", "7:false"]);
  });
});

describe("compatibility modules", () => {
  it("treats a module named after what it wraps, or a compat/shim module, as intentional", () => {
    const rules = DEPRECATION_RULES.filter((r) => r.ecosystem === "python");
    expect(matchDeprecations("pip/locations/_distutils.py", "from distutils.cmd import Command\n", rules).map((m) => m.guarded)).toEqual([true]);
    expect(matchDeprecations("pkg/_compat.py", "import imp\n", rules).map((m) => m.guarded)).toEqual([true]);
    expect(matchDeprecations("pkg/loader.py", "import imp\n", rules).map((m) => m.guarded)).toEqual([false]);
    for (const path of ["pkg/simple.py", "pkg/impl.py", "pkg/importer.py"]) expect(matchDeprecations(path, "import imp\n", rules).map((m) => m.guarded), path).toEqual([false]);
    expect(matchDeprecations("pkg/imp_compat.py", "import imp\n", rules).map((m) => m.guarded)).toEqual([true]);
  });
});
