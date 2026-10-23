export interface Dependency {
  name: string;
  /** Exact version when pinned or locked; otherwise the raw specifier. */
  version: string | undefined;
  pinned: boolean;
  dev: boolean;
}

export interface PythonManifest {
  paths: string[];
  name: string | undefined;
  /** Raw `requires-python`, e.g. ">=3.9". */
  requiresPython: string | undefined;
  /** Minor versions claimed via classifiers, e.g. ["3.9", "3.10"]. */
  classifierVersions: string[];
  dependencies: Dependency[];
  scripts: string[];
  packageManager: "uv" | "poetry" | "pdm" | "hatch" | "pipenv" | "pip";
  tooling: string[];
  /** Top-level package directories, e.g. ["src/foo"] or ["foo"]. */
  packageDirs: string[];
  hasPyTyped: boolean;
  /** Names of `[project.optional-dependencies]` extras, e.g. ["doc", "test"]. */
  extras: string[];
  /** Names of PEP 735 `[dependency-groups]`, e.g. ["dev"]. */
  dependencyGroups: string[];
}

export interface NodeManifest {
  paths: string[];
  name: string | undefined;
  private: boolean;
  hasBin: boolean;
  hasMainOrExports: boolean;
  engines: string | undefined;
  scripts: Record<string, string>;
  dependencies: Dependency[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  tooling: string[];
  workspaces: boolean;
}

export interface GoManifest {
  paths: string[];
  module: string | undefined;
  goVersion: string | undefined;
  dependencies: Dependency[];
  hasMainPackage: boolean;
  tooling: string[];
}

export interface RustManifest {
  paths: string[];
  name: string | undefined;
  edition: string | undefined;
  dependencies: Dependency[];
  hasBin: boolean;
  hasLib: boolean;
  tooling: string[];
}

export interface OtherManifest {
  ecosystem: "java" | "ruby" | "php" | "dotnet" | "c_cpp" | "swift" | "dart" | "elixir";
  paths: string[];
  packageManager: string | undefined;
  tooling: string[];
}

export interface Manifests {
  python?: PythonManifest;
  node?: NodeManifest;
  go?: GoManifest;
  rust?: RustManifest;
  others: OtherManifest[];
}
