import { describe, expect, it } from "vitest";
import { centralFiles, goTargets, jsTargets, pythonTargets, rustTargets } from "../src/profile/imports.ts";
import { inventoryOf, reader } from "./helpers/inventory.ts";

describe("import graph", () => {
  const paths = new Set(["pkg/__init__.py", "pkg/core.py", "pkg/util/__init__.py", "pkg/util/text.py", "src/lib/a.ts", "src/lib/b.ts", "src/lib/c/index.ts", "cmd/tool/main.go", "internal/scan/scan.go", "src/main.rs", "src/parser.rs", "src/tui/mod.rs"]);

  it("resolves python absolute and relative imports to files", () => {
    const text = "from pkg.core import run\nimport pkg.util.text\nfrom .util import text\nfrom . import core\n";
    expect(pythonTargets("pkg/cli.py", text, paths).sort()).toEqual(["pkg/__init__.py", "pkg/core.py", "pkg/util/__init__.py", "pkg/util/text.py"]);
  });

  it("resolves relative JS/TS imports with extensions and index files", () => {
    const text = 'import { a } from "./a";\nconst b = require("./b.js");\nimport("./c");\nimport x from "zod";\n';
    expect(jsTargets("src/lib/entry.ts", text, paths).sort()).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/c/index.ts"]);
  });

  it("resolves Go module-internal packages to directories and Rust modules to files", () => {
    expect(goTargets("cmd/tool/main.go", 'import (\n\t"fmt"\n\t"example.com/tool/internal/scan"\n)\n', "example.com/tool", paths)).toEqual(["internal/scan"]);
    expect(rustTargets("src/main.rs", "mod parser;\nmod tui;\nuse crate::parser::Parse;\n", paths).sort()).toEqual(["src/parser.rs", "src/tui/mod.rs"]);
  });

  it("ranks files by how many others import them", async () => {
    const inv = inventoryOf(["pkg/__init__.py", "pkg/core.py", "pkg/a.py", "pkg/b.py", "pkg/c.py"]);
    const result = await centralFiles(inv, reader({
      "pkg/a.py": "from pkg.core import x\n", "pkg/b.py": "from pkg.core import y\nfrom pkg.a import z\n", "pkg/c.py": "from pkg.core import w\n", "pkg/core.py": "", "pkg/__init__.py": "",
    }), undefined);
    expect(result.files).toEqual([{ path: "pkg/core.py", importedBy: 3 }]);
  });
});
