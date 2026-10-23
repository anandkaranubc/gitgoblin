import type { FileInventory } from "../fs/scan.ts";
import { readGoManifest } from "./go.ts";
import { readNodeManifest } from "./node.ts";
import { readPythonManifest } from "./python.ts";
import { readRustManifest } from "./rust.ts";
import type { Manifests, OtherManifest } from "./types.ts";

export type { Dependency, GoManifest, Manifests, NodeManifest, OtherManifest, PythonManifest, RustManifest } from "./types.ts";

type Reader = (path: string) => Promise<string | undefined>;

export async function detectManifests(inventory: FileInventory, read: Reader): Promise<Manifests> {
  const [python, node, go, rust] = await Promise.all([
    readPythonManifest(inventory, read),
    readNodeManifest(inventory, read),
    readGoManifest(inventory, read),
    readRustManifest(inventory, read),
  ]);
  const manifests: Manifests = { others: detectOthers(inventory) };
  if (python) manifests.python = python;
  if (node) manifests.node = node;
  if (go) manifests.go = go;
  if (rust) manifests.rust = rust;
  return manifests;
}

function detectOthers(inventory: FileInventory): OtherManifest[] {
  const has = (p: string) => inventory.byPath.has(p);
  const any = (re: RegExp) => inventory.files.some((f) => !f.vendored && re.test(f.path));
  const found: OtherManifest[] = [];
  if (has("pom.xml")) found.push({ ecosystem: "java", paths: ["pom.xml"], packageManager: "maven", tooling: ["maven"] });
  else if (has("build.gradle") || has("build.gradle.kts")) {
    found.push({ ecosystem: "java", paths: [has("build.gradle") ? "build.gradle" : "build.gradle.kts"], packageManager: "gradle", tooling: ["gradle"] });
  }
  if (has("Gemfile") || any(/^[^/]+\.gemspec$/)) {
    const tooling = ["bundler"];
    if (has(".rspec") || any(/^spec\//)) tooling.push("rspec");
    if (has(".rubocop.yml")) tooling.push("rubocop");
    found.push({ ecosystem: "ruby", paths: ["Gemfile"].filter(has), packageManager: "bundler", tooling });
  }
  if (has("composer.json")) found.push({ ecosystem: "php", paths: ["composer.json"], packageManager: "composer", tooling: ["composer", ...(has("phpunit.xml") || has("phpunit.xml.dist") ? ["phpunit"] : [])] });
  if (any(/\.(csproj|fsproj|sln)$/)) found.push({ ecosystem: "dotnet", paths: inventory.files.filter((f) => /\.(csproj|fsproj|sln)$/.test(f.path)).map((f) => f.path).slice(0, 5), packageManager: "nuget", tooling: ["dotnet"] });
  if (has("Package.swift")) found.push({ ecosystem: "swift", paths: ["Package.swift"], packageManager: "swiftpm", tooling: ["swift"] });
  if (has("pubspec.yaml")) found.push({ ecosystem: "dart", paths: ["pubspec.yaml"], packageManager: "pub", tooling: ["dart"] });
  if (has("mix.exs")) found.push({ ecosystem: "elixir", paths: ["mix.exs"], packageManager: "mix", tooling: ["mix"] });
  if (has("CMakeLists.txt") || has("meson.build") || has("configure.ac") || has("Makefile.am") || ((has("Makefile") || has("makefile")) && any(/\.(c|cc|cpp|h|hpp)$/))) {
    const tooling = [has("CMakeLists.txt") ? "cmake" : has("meson.build") ? "meson" : has("configure.ac") || has("Makefile.am") ? "autotools" : "make"];
    found.push({ ecosystem: "c_cpp", paths: ["CMakeLists.txt", "meson.build", "configure.ac", "Makefile.am", "Makefile"].filter(has), packageManager: undefined, tooling });
  }
  return found;
}
