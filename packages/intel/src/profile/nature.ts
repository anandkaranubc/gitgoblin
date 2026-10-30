import type { RepoNature } from "../contracts.ts";
import type { FileInventory } from "../fs/scan.ts";
import type { RepoMeta } from "../github/types.ts";
import type { Manifests } from "../manifests/index.ts";

export interface NatureResult {
  nature: RepoNature;
  reason: string;
}

export interface NatureInput {
  meta: Pick<RepoMeta, "name" | "description" | "topics" | "isTemplate">;
  inventory: FileInventory;
  manifests: Manifests;
  readme: string | undefined;
}

/** Decide what kind of thing a repository is. Rules run in order; the first confident match wins. */
export function classifyNature(input: NatureInput): NatureResult {
  const { meta, inventory, manifests } = input;
  const name = meta.name.toLowerCase();
  const description = (meta.description ?? "").toLowerCase();
  const topics = meta.topics.map((t) => t.toLowerCase());
  const readme = input.readme ?? "";
  const files = inventory.files.filter((f) => !f.vendored);
  const source = files.filter((f) => f.category === "source");
  const docs = files.filter((f) => f.category === "docs");
  const fromManifest = classifyFromManifests(manifests, files.map((f) => f.path));

  if (/^awesome([-_]|$)/.test(name) || topics.includes("awesome-list") || topics.includes("awesome")) {
    return { nature: "awesome_list", reason: "name or topics mark it as an awesome list" };
  }
  if (/dotfiles|\.config$|dot-files|nvim-config|vim-config|rc-files/.test(name) || hasDotfiles(files.map((f) => f.path))) {
    return { nature: "config", reason: "repository holds personal configuration files" };
  }
  if (meta.isTemplate || /\b(template|boilerplate|starter|skeleton|cookiecutter|scaffold)\b/.test(name)) {
    return { nature: "template", reason: meta.isTemplate ? "marked as a template repository" : "name says template or boilerplate" };
  }
  if (/\b(cheat-?sheets?|roadmaps?|interview|curriculum|syllabus)\b/.test(name + " " + description)) {
    return { nature: "docs", reason: "a reference document rather than software" };
  }
  const learning = /\b(tutorials?|course|workshop|exercises?|katas?|learn(ing)?|examples?|samples?|playground|the-book|handbook|100-days|30-days|challenges?)\b/;
  // Descriptions use these words for libraries too ("reinforcement learning algorithms", "audio samples"): there a manifest
  // that makes it a library or CLI wins. A name that says so still counts (golang/example has a go.mod).
  const packaged = fromManifest?.nature === "library" || fromManifest?.nature === "cli";
  if ((learning.test(name) || (learning.test(description) && !packaged)) && source.length < 400) {
    return { nature: "tutorial", reason: "name or description describes learning material" };
  }
  if (files.length > 0 && docs.length / files.length > 0.7 && source.length < 5) {
    return { nature: "docs", reason: `${Math.round((docs.length / files.length) * 100)}% of files are documents and almost no code` };
  }
  const dataExt = new Set([".csv", ".tsv", ".parquet", ".json", ".geojson", ".jsonl", ".xml", ".sqlite", ".db", ".npy", ".h5"]);
  const dataBytes = files.filter((f) => dataExt.has(f.ext)).reduce((n, f) => n + f.sizeBytes, 0);
  const totalBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
  if (totalBytes > 0 && dataBytes / totalBytes > 0.8 && source.length < 10) {
    return { nature: "data", reason: "most bytes are data files with little code" };
  }
  if (inventory.byPath.has("CITATION.cff") || /arxiv\.org|official (pytorch |tensorflow |jax )?implementation|@inproceedings|@article\{|paper:/i.test(readme.slice(0, 6000))) {
    return { nature: "research", reason: inventory.byPath.has("CITATION.cff") ? "has a CITATION.cff" : "README cites a paper or an official implementation" };
  }
  if (/\b(plugin|extension|addon|add-on)\b|\.nvim$|-vim$|-mode$|^vscode-|-vscode$|^zsh-|^oh-my-/.test(name) || topics.some((t) => /plugin|extension/.test(t))) {
    return { nature: "plugin", reason: "name or topics describe a plugin or extension to another tool" };
  }
  if (/\bframework\b/.test(description) || topics.includes("framework")) {
    return { nature: "framework", reason: "describes itself as a framework" };
  }

  if (fromManifest) return fromManifest;

  if (files.some((f) => /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f.path))) {
    return { nature: "application", reason: "ships a Dockerfile or compose file and no package manifest" };
  }
  return { nature: "unknown", reason: "no manifest or naming signal matched" };
}

function hasDotfiles(paths: string[]): boolean {
  const names = new Set([".zshrc", ".bashrc", ".vimrc", ".tmux.conf", "init.vim", "init.lua", ".gitconfig", ".bash_profile"]);
  return paths.filter((p) => names.has(p) || names.has(p.split("/").pop() ?? "")).length >= 3;
}

const APP_FRAMEWORK_DEPS = new Set([
  "next", "nuxt", "express", "fastify", "koa", "@nestjs/core", "react-scripts", "gatsby", "remix", "@remix-run/node",
  "@angular/core", "svelte", "@sveltejs/kit", "vue", "astro", "electron", "hono",
]);

function classifyFromManifests(manifests: Manifests, paths: string[]): NatureResult | undefined {
  const { node, python, go, rust, others } = manifests;
  const has = (p: string) => paths.includes(p);

  if (node) {
    const deps = new Set(node.dependencies.filter((d) => !d.dev).map((d) => d.name));
    const appFramework = [...deps].find((d) => APP_FRAMEWORK_DEPS.has(d));
    if (node.private && node.workspaces && paths.some((p) => /^packages\/[^/]+\/package\.json$/.test(p))) {
      return { nature: "library", reason: "monorepo root with publishable packages under packages/" };
    }
    if (node.private && !node.hasBin) {
      return { nature: "application", reason: `package.json is private${appFramework ? ` and depends on ${appFramework}` : ""}` };
    }
    if (node.hasBin && !node.hasMainOrExports) return { nature: "cli", reason: "package.json declares a bin and no library entry" };
    if (node.hasMainOrExports || node.name) {
      return { nature: "library", reason: node.hasBin ? "publishable package with both a library entry and a bin" : "publishable package.json with a library entry" };
    }
  }
  if (python) {
    if (has("manage.py") || paths.some((p) => /(^|\/)wsgi\.py$|(^|\/)asgi\.py$/.test(p))) {
      return { nature: "application", reason: "Django or ASGI application layout" };
    }
    if (python.scripts.length > 0 && python.packageDirs.length === 0) {
      return { nature: "cli", reason: "declares console scripts without an importable package" };
    }
    if (python.scripts.length > 0 && /\b(cli|command[- ]line|tool)\b/i.test(python.name ?? "")) {
      return { nature: "cli", reason: "console scripts and a CLI-flavoured name" };
    }
    if (python.name && python.packageDirs.length > 0) return { nature: "library", reason: "installable Python package" };
    if (python.name) return { nature: "library", reason: "pyproject or setup.py defines a distributable package" };
    if (paths.some((p) => /^(app|main|server)\.py$/.test(p))) return { nature: "application", reason: "requirements file with an app entry point" };
  }
  if (go) {
    if (go.hasMainPackage) return { nature: "cli", reason: "Go module with a main package (cmd/ or main.go)" };
    return { nature: "library", reason: "Go module without a main package" };
  }
  if (rust) {
    if (rust.hasBin && !rust.hasLib) return { nature: "cli", reason: "Cargo package with src/main.rs and no lib" };
    return { nature: "library", reason: rust.hasBin ? "Cargo package with a library and binaries" : "Cargo library crate" };
  }
  const other = others[0];
  if (other?.ecosystem === "c_cpp" && paths.some((p) => /^(src\/)?main\.(c|cc|cpp)$/.test(p))) return { nature: "cli", reason: "C/C++ project with a top-level main.c" };
  if (other) return { nature: "library", reason: `${other.ecosystem} project with ${other.paths[0] ?? "a manifest"}` };
  return undefined;
}
