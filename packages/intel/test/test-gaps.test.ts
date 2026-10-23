import { describe, expect, it } from "vitest";
import { buildTestIndex, findSkippedTests, looksUntested, stemWords, testedStem } from "../src/analyzers/test-gaps.ts";

describe("test gap heuristics", () => {
  it("derives the tested module from test file names", () => {
    expect(testedStem("tests/test_parser.py")).toBe("parser");
    expect(testedStem("pkg/parser_test.go")).toBe("parser");
    expect(testedStem("src/Parser.test.tsx")).toBe("parser");
    expect(testedStem("spec/parser_spec.rb")).toBe("parser");
    expect(testedStem("src/test/java/ParserTest.java")).toBe("parser");
    expect(testedStem("tests/conftest.py")).toBeUndefined();
  });

  it("treats a source as tested when a test names or mentions it, and stays quiet on generic names", () => {
    const index = buildTestIndex([
      { path: "tests/test_parser.py", text: "from pkg.parser import parse\nfrom pkg import renderer\n" },
      { path: "pkg/net/conn_test.go", text: "package net" },
    ]);
    expect(looksUntested("pkg/parser.py", "", index)).toBe(false);
    expect(looksUntested("pkg/renderer.py", "", index)).toBe(false);
    expect(looksUntested("pkg/scheduler.py", "", index)).toBe(true);
    expect(looksUntested("pkg/utils.py", "", index)).toBe(false);
    expect(looksUntested("pkg/net/conn.go", "", index)).toBe(false);
    expect(looksUntested("pkg/other/thing.go", "", index)).toBe(true);
    expect(looksUntested("src/engine.rs", "#[cfg(test)]\nmod tests {}", index)).toBe(false);
    expect(stemWords("PalmImagePlugin")).toEqual(["palm"]);
    expect(stemWords("test_file_tga")).toEqual(["tga"]);
    expect(stemWords("test_api_client")).toEqual([]);
    const pillow = buildTestIndex([{ path: "Tests/test_file_palm.py", text: "from PIL import Image" }]);
    expect(looksUntested("src/PIL/PalmImagePlugin.py", "", pillow)).toBe(false);
    expect(looksUntested("src/PIL/TgaImagePlugin.py", "", pillow)).toBe(true);
    const tga = buildTestIndex([{ path: "Tests/test_file_tga.py", text: "" }]);
    expect(looksUntested("src/PIL/TgaImagePlugin.py", "", tga)).toBe(false);
  });

  it("finds skips without an environmental reason", () => {
    const py = `
@pytest.mark.skip(reason="flaky, see #123")
def test_a(): ...
@pytest.mark.skipif(sys.platform == "win32", reason="windows")
def test_b(): ...
@pytest.mark.skip(reason="requires GPU")
def test_c(): ...
@pytest.mark.xfail
def test_d(): ...
`;
    const found = findSkippedTests("tests/test_x.py", py);
    expect(found.map((f) => f.line)).toEqual([2, 8]);
    expect(found[0]?.reason).toBe("flaky, see #123");
    const js = "it.skip('does thing', () => {});\ntest('ok', () => {});\nit.skip('needs network', () => {});";
    expect(findSkippedTests("a.test.js", js).map((f) => f.line)).toEqual([1]);
    const go = 'func TestA(t *testing.T) {\n\tif testing.Short() {\n\t\tt.Skip("short test")\n\t}\n\tt.Skip("TODO: flaky on CI, see #12")\n}';
    expect(findSkippedTests("a_test.go", go).map((f) => [f.line, f.reason])).toEqual([[5, "TODO: flaky on CI, see #12"]]);
  });
});

describe("perModuleShare", () => {
  it("counts modules that have a test named after them, ignoring generic names, Go, Rust and headers", async () => {
    const { buildTestIndex, perModuleShare } = await import("../src/analyzers/test-gaps.ts");
    const index = buildTestIndex([{ path: "tests/test_sessions.py", text: "" }, { path: "tests/jq.test", text: "" }]);
    const sources = ["src/pkg/sessions.py", "src/pkg/adapters.py", "src/pkg/utils.py", "src/pkg/cookies.py", "cmd/main.go", "src/lib.rs", "src/jv.h"].map((path) => ({ path }));
    expect(perModuleShare(sources, index)).toEqual({ named: 1, eligible: 3 });
  });
});

describe("untested-file judgement", () => {
  it("does not claim a module is untested when its name has nothing distinctive to match", async () => {
    const { buildTestIndex, looksUntested } = await import("../src/analyzers/test-gaps.ts");
    const index = buildTestIndex([{ path: "tests/unit/type/set.tcl", text: "" }]);
    expect(looksUntested("src/t_set.c", "int x;", index)).toBe(false);
    expect(looksUntested("src/conncache.c", "int x;", index)).toBe(true);
  });
});
