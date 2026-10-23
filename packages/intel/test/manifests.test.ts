import { describe, expect, it } from "vitest";
import { detectManifests } from "../src/manifests/index.ts";
import { classifierVersions, parseRequirement, parseRequirements } from "../src/manifests/python.ts";
import { inventoryOf, reader } from "./helpers/inventory.ts";

describe("python manifest", () => {
  it("reads pyproject metadata, tooling and dependencies", async () => {
    const inv = inventoryOf(["pyproject.toml", "uv.lock", "src/foo/__init__.py", "src/foo/py.typed", "tests/test_foo.py"]);
    const m = await detectManifests(inv, reader({
      "pyproject.toml": `
[project]
name = "foo-bar"
requires-python = ">=3.9"
classifiers = ["Programming Language :: Python :: 3.9", "Programming Language :: Python :: 3.12"]
dependencies = ["requests>=2", "click==8.1.7"]
[project.optional-dependencies]
dev = ["pytest", "ruff"]
[project.scripts]
foo = "foo.cli:main"
[tool.ruff]
line-length = 100
[tool.mypy]
strict = true
`,
    }));
    const py = m.python!;
    expect(py.name).toBe("foo-bar");
    expect(py.requiresPython).toBe(">=3.9");
    expect(py.classifierVersions).toEqual(["3.9", "3.12"]);
    expect(py.packageManager).toBe("uv");
    expect(py.packageDirs).toEqual(["src/foo"]);
    expect(py.hasPyTyped).toBe(true);
    expect(py.scripts).toEqual(["foo"]);
    expect(py.tooling).toEqual(expect.arrayContaining(["ruff", "mypy", "pytest"]));
    expect(py.dependencies.find((d) => d.name === "click")).toMatchObject({ version: "8.1.7", pinned: true, dev: false });
    expect(py.dependencies.find((d) => d.name === "pytest")?.dev).toBe(true);
  });

  it("parses requirements files and requirement specifiers", () => {
    expect(parseRequirement("Django>=4.2,<5", false)).toMatchObject({ name: "django", pinned: false });
    expect(parseRequirement("numpy==1.26.4 ; python_version < '3.13'", false)).toMatchObject({ name: "numpy", version: "1.26.4", pinned: true });
    expect(parseRequirement("Some_Pkg[extra]", false).name).toBe("some-pkg");
    const deps = parseRequirements("# comment\n-r base.txt\nflask==3.0.0  # web\n\ngit+https://x/y.git\n", false);
    expect(deps).toHaveLength(1);
    expect(deps[0]?.name).toBe("flask");
  });

  it("extracts classifier versions in order", () => {
    expect(classifierVersions(["Programming Language :: Python :: 3.10", "Programming Language :: Python :: 3.8", "Programming Language :: Python :: 3 :: Only"])).toEqual(["3.8", "3.10"]);
  });
});

describe("node, go and rust manifests", () => {
  it("reads package.json shape and detects the package manager and tooling", async () => {
    const inv = inventoryOf(["package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js"]);
    const m = await detectManifests(inv, reader({
      "package.json": JSON.stringify({ name: "x", bin: { x: "cli.js" }, scripts: { test: "vitest run", build: "tsc" }, dependencies: { zod: "^3.0.0" }, devDependencies: { vitest: "2.0.0" }, engines: { node: ">=18" } }),
    }));
    expect(m.node).toMatchObject({ name: "x", hasBin: true, hasMainOrExports: false, packageManager: "pnpm", engines: ">=18" });
    expect(m.node?.tooling).toEqual(expect.arrayContaining(["typescript", "eslint", "vitest"]));
    expect(m.node?.dependencies.find((d) => d.name === "vitest")).toMatchObject({ pinned: true, dev: true });
  });

  it("reads go.mod and Cargo.toml", async () => {
    const inv = inventoryOf(["go.mod", "go.sum", "cmd/tool/main.go", "Cargo.toml", "src/main.rs", "src/lib.rs"]);
    const m = await detectManifests(inv, reader({
      "go.mod": "module example.com/tool\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sys v0.1.0 // indirect\n)\n",
      "Cargo.toml": '[package]\nname = "tool"\nedition = "2021"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nanyhow = "1"\n',
    }));
    expect(m.go).toMatchObject({ module: "example.com/tool", goVersion: "1.22", hasMainPackage: true });
    expect(m.go?.dependencies).toEqual([
      { name: "github.com/spf13/cobra", version: "v1.8.0", pinned: true, dev: false },
      { name: "golang.org/x/sys", version: "v0.1.0", pinned: true, dev: true },
    ]);
    expect(m.rust).toMatchObject({ name: "tool", edition: "2021", hasBin: true, hasLib: true });
    expect(m.rust?.dependencies.map((d) => d.name)).toEqual(["serde", "anyhow"]);
  });
});
