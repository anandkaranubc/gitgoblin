import { describe, expect, it } from "vitest";
import { categorize, isDocsPath, isTestPath, isVendored, languageOf } from "../src/fs/scan.ts";

describe("scan classification", () => {
  it("detects vendored and generated paths without flagging similar file names", () => {
    expect(isVendored("node_modules/x/index.js")).toBe(true);
    expect(isVendored("vendor/github.com/x/y.go")).toBe(true);
    expect(isVendored("web/static/app.min.js")).toBe(true);
    expect(isVendored("proto/api_pb2.py")).toBe(true);
    expect(isVendored("src/builder.py")).toBe(false);
    expect(isVendored("dist")).toBe(false);
  });

  it("recognises test files across ecosystems", () => {
    for (const p of [
      "tests/test_api.py", "src/api_test.go", "src/api.test.ts", "lib/api.spec.js",
      "spec/api_spec.rb", "src/test/java/ApiTest.java", "conftest.py",
    ]) expect(isTestPath(p), p).toBe(true);
    expect(isTestPath("src/testing_utils.py")).toBe(false);
    expect(isTestPath("src/contest.py")).toBe(false);
  });

  it("categorises docs, ci, config and source", () => {
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("docs/guide.rst")).toBe(true);
    expect(isDocsPath("src/notes.md")).toBe(false);
    expect(categorize(".github/workflows/ci.yml")).toBe("ci");
    expect(categorize("pyproject.toml")).toBe("config");
    expect(categorize("package-lock.json")).toBe("config");
    expect(categorize("src/main.rs")).toBe("source");
    expect(categorize("LICENSE")).toBe("other");
    expect(languageOf("a/b.tsx")).toBe("TypeScript");
  });
});
