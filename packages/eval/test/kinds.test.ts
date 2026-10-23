import { describe, expect, it } from "vitest";
import { classifyChange, kindOfPath } from "../src/kinds.ts";

describe("kindOfPath", () => {
  it("recognises docs, CI, tests and dependency manifests", () => {
    expect(kindOfPath("README.md")).toBe("docs");
    expect(kindOfPath("docs/guide/index.html")).toBe("docs");
    expect(kindOfPath(".github/workflows/ci.yml")).toBe("ci");
    expect(kindOfPath("Dockerfile")).toBe("ci");
    expect(kindOfPath("tests/test_api.py")).toBe("tests");
    expect(kindOfPath("src/foo.test.ts")).toBe("tests");
    expect(kindOfPath("package-lock.json")).toBe("dependencies");
    expect(kindOfPath("go.mod")).toBe("dependencies");
    expect(kindOfPath("src/lib/thing.rs")).toBe("code");
    expect(kindOfPath("CHANGELOG.md")).toBe("docs");
  });
});

describe("classifyChange", () => {
  it("names the single kind, lets tests ride along with code, and calls the rest mixed", () => {
    expect(classifyChange(["README.md", "docs/a.md"])).toBe("docs");
    expect(classifyChange(["src/a.ts", "src/a.test.ts"])).toBe("code");
    expect(classifyChange(["src/a.ts", "README.md"])).toBe("mixed");
    expect(classifyChange([])).toBeUndefined();
  });
});
