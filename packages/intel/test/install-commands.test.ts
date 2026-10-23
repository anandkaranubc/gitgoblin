import { describe, expect, it } from "vitest";
import { readPythonManifest } from "../src/manifests/python.ts";
import { nodeInstall, pythonInstall } from "../src/profile/ecosystems.ts";
import { inventoryOf, reader } from "./helpers/inventory.ts";

/** The install command runs before an agent touches anything: it must install what the tests need and never rewrite a lockfile. */
describe("install commands", () => {
  it("installs PEP 735 dependency groups instead of a dev extra that does not exist", async () => {
    // tenacity: extras doc and test, dev tools in [dependency-groups] dev.
    const pyproject = '[project]\nname = "tenacity"\n[project.optional-dependencies]\ndoc = ["sphinx"]\ntest = ["pytest"]\n[dependency-groups]\ndev = ["pytest", "tornado", "mypy", { include-group = "lint" }]\nlint = ["ruff"]\n';
    const inventory = inventoryOf(["pyproject.toml", "tenacity/__init__.py"]);
    const m = await readPythonManifest(inventory, reader({ "pyproject.toml": pyproject }));
    expect(m?.extras).toEqual(["doc", "test"]);
    expect(m?.dependencyGroups).toEqual(["dev", "lint"]);
    expect(m?.dependencies.map((d) => d.name)).toEqual(expect.arrayContaining(["tornado", "mypy", "ruff"]));
    expect(pythonInstall(m!, inventory)).toBe("python -m pip install --upgrade pip && pip install -e . --group dev");
  });

  it("uses an extra only when the project declares it, and requirement files or a plain install otherwise", async () => {
    const base = { paths: ["pyproject.toml"], packageManager: "pip" as const, dependencyGroups: [], extras: [] as string[] };
    const inv = inventoryOf(["pyproject.toml"]);
    expect(pythonInstall({ ...base, extras: ["doc", "test"] } as never, inv)).toBe('pip install -e ".[test]"');
    expect(pythonInstall({ ...base, extras: ["dev", "test"] } as never, inv)).toBe('pip install -e ".[dev]"');
    expect(pythonInstall({ ...base } as never, inventoryOf(["pyproject.toml", "requirements-dev.txt"]))).toBe("pip install -e . -r requirements-dev.txt");
    expect(pythonInstall({ ...base } as never, inv)).toBe("pip install -e .");
    expect(pythonInstall({ ...base, packageManager: "uv" } as never, inv)).toBe("uv sync");
  });

  it("installs from the committed lockfile without rewriting it", () => {
    expect(nodeInstall("npm", inventoryOf(["package.json", "package-lock.json"]))).toBe("npm ci");
    expect(nodeInstall("npm", inventoryOf(["package.json"]))).toBe("npm install");
    expect(nodeInstall("pnpm", inventoryOf(["package.json", "pnpm-lock.yaml"]))).toBe("pnpm install --frozen-lockfile");
    expect(nodeInstall("yarn", inventoryOf(["package.json", "yarn.lock", ".yarnrc.yml"]))).toBe("yarn install --immutable");
    expect(nodeInstall("yarn", inventoryOf(["package.json", "yarn.lock"]))).toBe("yarn install --frozen-lockfile");
    expect(nodeInstall("bun", inventoryOf(["package.json", "bun.lock"]))).toBe("bun install --frozen-lockfile");
  });
});
