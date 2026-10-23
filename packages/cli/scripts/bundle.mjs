// Bundles the CLI for publishing. Runs from `npm pack` (prepack); development never needs it.
//
// Node refuses to strip TypeScript types under node_modules, and the sibling @gitgoblin packages are not
// published on their own, so the installed package must be plain JavaScript with them inlined. The engine
// becomes a chunk of its own, loaded only by `contribute` and `publish`, because it imports the Claude
// Agent SDK: that stays external (its licence does not allow redistribution, and its platform binary is
// hundreds of megabytes), and package.json declares it as an optional peer dependency.
import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeNotices } from "../../../scripts/notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

rmSync(`${root}dist`, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { gitgoblin: "src/bin.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Node built-ins stay external automatically; everything else is inlined except the Agent SDK.
  packages: "bundle",
  external: ["@anthropic-ai/claude-agent-sdk"],
  // Some dependencies are CommonJS and call require(); an ESM bundle needs a real one in scope.
  banner: { js: "import { createRequire as __gitgoblinCreateRequire } from \"node:module\"; const require = __gitgoblinCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs);
const bytes = outputs.reduce((sum, [, o]) => sum + o.bytes, 0);
console.error(`bundled ${(bytes / 1024).toFixed(0)} KB into ${outputs.length} files under dist/`);

// The bundle carries other people's code; their licenses travel with it, and ours with the package.
const { packages, warnings } = writeNotices(result.metafile, `${root}dist/THIRD_PARTY_NOTICES.md`, { root, product: "gitgoblin" });
for (const warning of warnings) console.error(`notice warning: ${warning}`);
console.error(`wrote dist/THIRD_PARTY_NOTICES.md for ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}`);
copyFileSync(`${root}../../LICENSE`, `${root}LICENSE`);
