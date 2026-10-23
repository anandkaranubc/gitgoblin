// Bundles the server into one file for publishing. Runs from `npm pack` (prepack); development never needs it.
//
// Node refuses to strip TypeScript types under node_modules, and the sibling @gitgoblin packages are not
// published on their own, so the installed package must be plain JavaScript. Bundling everything, npm
// dependencies included, leaves the published package with no dependencies at all: one download for `npx`.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeNotices } from "./notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/gitgoblin-mcp.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Node built-ins stay external automatically; everything else is inlined.
  packages: "bundle",
  // Intel loads the Anthropic SDK only when its optional model review runs, which the server never
  // turns on, so the SDK stays out of the bundle (about 1 MB less for every cold start).
  external: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/*"],
  // Some dependencies are CommonJS and call require(); an ESM bundle needs a real one in scope.
  banner: { js: "import { createRequire as __gitgoblinCreateRequire } from \"node:module\"; const require = __gitgoblinCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.error(`bundled ${(bytes / 1024).toFixed(0)} KB into dist/gitgoblin-mcp.mjs`);

// The bundle carries other people's code; their licenses travel with it, and ours with the package.
const { packages, warnings } = writeNotices(result.metafile, `${root}dist/THIRD_PARTY_NOTICES.md`, { root, product: "@gitgoblin/mcp" });
for (const warning of warnings) console.error(`notice warning: ${warning}`);
console.error(`wrote dist/THIRD_PARTY_NOTICES.md for ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}`);
copyFileSync(`${root}../../LICENSE`, `${root}LICENSE`);
