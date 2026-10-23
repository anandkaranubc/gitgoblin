// Builds the MCPB bundle (https://github.com/modelcontextprotocol/mcpb): the double-click install for
// Claude Desktop and the artifact the MCP Registry entry points at. Run `npm run bundle` first.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

for (const file of ["dist/gitgoblin-mcp.mjs", "dist/THIRD_PARTY_NOTICES.md"]) {
  if (!existsSync(`${root}${file}`)) throw new Error(`${file} is missing; run \`npm run bundle\` first`);
}

// The bundle has the same layout as the npm package, so the launcher behaves identically in both.
const stage = `${root}dist/mcpb`;
rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}/bin`, { recursive: true });
mkdirSync(`${stage}/dist`);
cpSync(`${root}bin/gitgoblin-mcp.mjs`, `${stage}/bin/gitgoblin-mcp.mjs`);
cpSync(`${root}dist/gitgoblin-mcp.mjs`, `${stage}/dist/gitgoblin-mcp.mjs`);
cpSync(`${root}README.md`, `${stage}/README.md`);
cpSync(`${root}../../LICENSE`, `${stage}/LICENSE`);
cpSync(`${root}dist/THIRD_PARTY_NOTICES.md`, `${stage}/THIRD_PARTY_NOTICES.md`);
cpSync(`${root}../../brand/favicon/icon-512.png`, `${stage}/icon.png`);
writeFileSync(`${stage}/package.json`, `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module" }, null, 2)}\n`);

const manifest = {
  manifest_version: "0.3",
  name: "gitgoblin",
  display_name: "gitgoblin",
  version: pkg.version,
  description: "Discover open-source repositories worth your time and evidence-backed contribution opportunities.",
  long_description:
    "gitgoblin finds open-source work worth doing and explains why, with evidence a person can check. Discover repositories for a goal (contribute, learn, adopt, revive, explore), profile one the way a careful new maintainer would, and get a briefing on one concrete opportunity: unclaimed issues, stale pull requests worth reviving, CI about to break, docs that contradict the code, and more. Read-only; it never writes to GitHub.",
  author: { name: "Karan Anand", url: "https://github.com/anandkaranubc" },
  homepage: "https://anandkaranubc.github.io/gitgoblin/",
  documentation: "https://github.com/anandkaranubc/gitgoblin/blob/main/docs/agents.md",
  support: "https://github.com/anandkaranubc/gitgoblin/issues",
  repository: { type: "git", url: "https://github.com/anandkaranubc/gitgoblin" },
  license: "MIT",
  icon: "icon.png",
  keywords: ["open-source", "github", "contributing", "good-first-issue", "repository-discovery"],
  server: {
    type: "node",
    entry_point: "bin/gitgoblin-mcp.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/bin/gitgoblin-mcp.mjs"],
      env: { GITHUB_TOKEN: "${user_config.github_token}" },
    },
  },
  tools: [
    { name: "discover_repositories", description: "Rank public repositories for a goal, with the reasons behind each ranking." },
    { name: "explain_repository", description: "Every discovery signal for one repository under a goal, with evidence." },
    { name: "analyze_repository", description: "Profile one repository and rank evidence-backed contribution opportunities." },
    { name: "get_opportunity", description: "The full briefing for one opportunity, including how to work on the project." },
  ],
  user_config: {
    github_token: {
      type: "string",
      title: "GitHub token (optional)",
      description: "Any token that can read public repositories. Raises GitHub's rate limits and unlocks starter-issue data. Leave empty to use a GitHub CLI login or stay anonymous.",
      sensitive: true,
      required: false,
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=24.0.0" },
  },
};
writeFileSync(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

// The packer comes from node_modules, pinned by the lockfile like every other build input, never from a
// fresh `npx` download: whatever runs here shapes the bundle people install.
const mcpbManifest = findPackageJSON("@anthropic-ai/mcpb", import.meta.url);
const { bin } = JSON.parse(readFileSync(mcpbManifest, "utf8"));
const mcpbCli = join(dirname(mcpbManifest), typeof bin === "string" ? bin : bin.mcpb);
const mcpb = (...args) => execFileSync(process.execPath, [mcpbCli, ...args], { stdio: "inherit" });
mcpb("validate", `${stage}/manifest.json`);
const output = `${root}dist/gitgoblin.mcpb`;
rmSync(output, { force: true });
mcpb("pack", stage, output);

const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
console.error(`wrote dist/gitgoblin.mcpb (sha256 ${sha256})`);
