// Bundles the server into one file for publishing. Runs from `npm pack` (prepack); development never needs it.
//
// Node refuses to strip TypeScript types under node_modules, and the sibling @gitgoblin packages are not
// published on their own, so the installed package must be plain JavaScript. Bundling everything, npm
// dependencies included, leaves the published package with no dependencies at all: one download for `npx`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

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
  // Some dependencies are CommonJS and call require(); an ESM bundle needs a real one in scope.
  banner: { js: "import { createRequire as __gitgoblinCreateRequire } from \"node:module\"; const require = __gitgoblinCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.error(`bundled ${(bytes / 1024).toFixed(0)} KB into dist/gitgoblin-mcp.mjs`);
