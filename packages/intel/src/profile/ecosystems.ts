import type { Commands, Ecosystem } from "../contracts.ts";
import type { FileInventory } from "../fs/scan.ts";
import type { Manifests } from "../manifests/index.ts";

/** Ecosystems present, with the commands a contributor would run. */
export function describeEcosystems(manifests: Manifests, inventory: FileInventory, ciRunLines: string[]): Ecosystem[] {
  const result: Ecosystem[] = [];
  const { python, node, go, rust, others } = manifests;

  if (python) {
    const commands: Commands = {};
    const pm = python.packageManager;
    commands.install =
      pm === "uv" ? "uv sync" : pm === "poetry" ? "poetry install" : pm === "pdm" ? "pdm install" : pm === "pipenv" ? "pipenv install --dev"
      : inventory.byPath.has("requirements-dev.txt") ? "pip install -r requirements-dev.txt"
      : python.paths.includes("pyproject.toml") || python.paths.includes("setup.py") ? 'pip install -e ".[dev]"' : "pip install -r requirements.txt";
    const ciTest = pickCi(ciRunLines, /\b(pytest|tox|nox|python -m unittest|make test)\b/);
    commands.test = ciTest ?? (python.tooling.includes("tox") ? "tox" : python.tooling.includes("nox") ? "nox" : python.tooling.includes("pytest") ? "pytest" : python.tooling.includes("unittest") ? "python -m unittest discover" : undefined);
    if (python.tooling.includes("ruff")) commands.lint = "ruff check .";
    else if (python.tooling.includes("flake8")) commands.lint = "flake8";
    else if (python.tooling.includes("pylint")) commands.lint = "pylint " + (python.packageDirs[0] ?? ".");
    if (python.tooling.includes("ruff") && !python.tooling.includes("black")) commands.format = "ruff format .";
    else if (python.tooling.includes("black")) commands.format = "black .";
    if (python.tooling.includes("mypy")) commands.typecheck = "mypy " + (python.packageDirs[0] ?? ".");
    else if (python.tooling.includes("pyright")) commands.typecheck = "pyright";
    if (python.tooling.includes("pre-commit")) commands.lint = commands.lint ?? "pre-commit run --all-files";
    result.push({
      name: "python",
      manifests: python.paths,
      packageManager: pm,
      tooling: python.tooling,
      commands: prune(commands),
      runtime: python.requiresPython ? `python ${python.requiresPython}` : python.classifierVersions.length ? `python ${python.classifierVersions[0]}+` : undefined,
    });
  }

  if (node) {
    const pm = node.packageManager;
    const run = (script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
    const commands: Commands = { install: pm === "yarn" ? "yarn" : `${pm} install` };
    if (node.scripts.test && !/no test specified/.test(node.scripts.test)) commands.test = pm === "npm" ? "npm test" : `${pm} test`;
    if (node.scripts.build) commands.build = run("build");
    if (node.scripts.lint) commands.lint = run("lint");
    if (node.scripts.format) commands.format = run("format");
    if (node.scripts.typecheck) commands.typecheck = run("typecheck");
    else if (node.scripts["type-check"]) commands.typecheck = run("type-check");
    else if (node.tooling.includes("typescript") && !node.scripts.build?.includes("tsc")) commands.typecheck = "npx tsc --noEmit";
    result.push({
      name: "node",
      manifests: node.paths,
      packageManager: pm,
      tooling: node.tooling,
      commands: prune(commands),
      runtime: node.engines ? `node ${node.engines}` : undefined,
    });
  }

  if (go) {
    const commands: Commands = { build: "go build ./...", test: pickCi(ciRunLines, /\bgo test\b/) ?? "go test ./..." };
    commands.lint = go.tooling.includes("golangci-lint") ? "golangci-lint run" : "go vet ./...";
    commands.format = "gofmt -l .";
    result.push({ name: "go", manifests: go.paths, packageManager: "go modules", tooling: go.tooling, commands, runtime: go.goVersion ? `go ${go.goVersion}` : undefined });
  }

  if (rust) {
    const commands: Commands = { build: "cargo build", test: "cargo test", lint: "cargo clippy --all-targets", format: "cargo fmt --check" };
    result.push({ name: "rust", manifests: rust.paths, packageManager: "cargo", tooling: rust.tooling, commands, runtime: rust.edition ? `edition ${rust.edition}` : undefined });
  }

  for (const other of others) {
    const commands: Commands = {};
    switch (other.ecosystem) {
      case "java":
        commands.build = other.packageManager === "maven" ? "mvn -q package" : "./gradlew build";
        commands.test = other.packageManager === "maven" ? "mvn test" : "./gradlew test";
        break;
      case "ruby":
        commands.install = "bundle install";
        commands.test = other.tooling.includes("rspec") ? "bundle exec rspec" : "bundle exec rake test";
        if (other.tooling.includes("rubocop")) commands.lint = "bundle exec rubocop";
        break;
      case "php":
        commands.install = "composer install";
        if (other.tooling.includes("phpunit")) commands.test = "vendor/bin/phpunit";
        break;
      case "dotnet":
        commands.build = "dotnet build";
        commands.test = "dotnet test";
        break;
      case "swift":
        commands.build = "swift build";
        commands.test = "swift test";
        break;
      case "dart":
        commands.install = "dart pub get";
        commands.test = "dart test";
        break;
      case "elixir":
        commands.install = "mix deps.get";
        commands.test = "mix test";
        break;
      case "c_cpp":
        commands.build = other.tooling[0] === "cmake" ? "cmake -B build && cmake --build build" : other.tooling[0] === "meson" ? "meson setup build && ninja -C build" : other.tooling[0] === "autotools" ? "autoreconf -i && ./configure && make" : "make";
        if (other.tooling[0] === "cmake") commands.test = "ctest --test-dir build";
        else if (other.tooling[0] === "autotools") commands.test = "make check";
        else if (other.tooling[0] === "meson") commands.test = "meson test -C build";
        break;
    }
    result.push({ name: other.ecosystem, manifests: other.paths, packageManager: other.packageManager, tooling: other.tooling, commands: prune(commands) });
  }
  return result;
}

function pickCi(lines: string[], pattern: RegExp): string | undefined {
  const hit = lines.find((l) => pattern.test(l) && l.length < 120 && !/\$\{\{/.test(l));
  return hit?.trim();
}

function prune(commands: Commands): Commands {
  return Object.fromEntries(Object.entries(commands).filter(([, v]) => v !== undefined)) as Commands;
}
