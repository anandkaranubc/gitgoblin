import { describe, expect, it } from "vitest";
import { jsExports, pythonDefines } from "../src/analyzers/docs-drift.ts";

describe("pythonDefines", () => {
  it("finds definitions, imports, aliases and __all__ entries, indented or not", () => {
    for (const source of [
      "def Missing(x):\n    pass",
      "class Foo:\n    async def Missing(self):\n        pass",
      "class Missing(Base):",
      "x = 1\n\n\n\nMissing = object()",
      "Missing: int = 3",
      "from .core import Thing, Missing",
      "import other as Missing",
      "from .core import Thing as Missing",
      "if TYPE_CHECKING:\n    from .core import Missing",
      '__all__ = ["Thing", "Missing"]',
    ]) expect(pythonDefines(source, "Missing"), source).toBe(true);
  });

  it("does not take other names, comments or prose for a definition", () => {
    for (const source of ["def NotMissing():", "# Missing = 1", "MissingValue = 1", "print(Missing)", '__all__ = ["Missing2"]']) {
      expect(pythonDefines(source, "Missing"), source).toBe(false);
    }
  });
});

describe("jsExports", () => {
  it("finds declarations, CommonJS exports and names in brace lists of any length", () => {
    const longList = `export {\n${Array.from({ length: 300 }, (_, i) => `  name${i},\n`).join("")}  Foo,\n};\n`;
    for (const source of [
      "export function Foo() {}",
      "export default class Foo {}",
      "export { a, b as c }\nexport { Foo } from './foo.js'",
      longList,
      "module.exports = { a, Foo }",
      "exports.Foo = Foo;",
      "export * from './all.js'",
    ]) expect(jsExports(source, "Foo"), source.slice(0, 60)).toBe(true);
  });

  it("does not count a name the brace lists leave out", () => {
    expect(jsExports("export { a, FooBar }\nconst Foo = 1;\nexport {", "Foo")).toBe(false);
  });
});
