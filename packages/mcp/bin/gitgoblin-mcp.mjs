#!/usr/bin/env node
// Entry point for `npx @gitgoblin/mcp` and for a clone of the repository.
import { existsSync } from "node:fs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  process.stderr.write(`gitgoblin-mcp needs Node.js 24 or newer; this is ${process.version}.\n`);
  process.exit(1);
}

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stdout.write("0.1.6\n");
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  process.stdout.write(
    [
      "gitgoblin-mcp: gitgoblin as an MCP server over stdio.",
      "",
      "It takes no arguments. Register it with your agent, for example:",
      "  claude mcp add gitgoblin -- npx -y <tarball URL from https://github.com/anandkaranubc/gitgoblin/releases>",
      "",
      "Optional: GITHUB_TOKEN or GH_TOKEN (or a GitHub CLI login) for higher rate limits.",
      "Docs: https://github.com/anandkaranubc/gitgoblin/tree/main/packages/mcp",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// The MCP stdio transport owns stdout. Anything else that prints there corrupts the protocol stream,
// so every console method that would write to stdout goes to stderr instead.
console.log = console.info = console.debug = (...args) => console.error(...args);

// A clone runs the TypeScript source on Node 24; the published package has no src/ and ships the bundle instead.
const source = new URL("../src/main.ts", import.meta.url);
const bundle = new URL("../dist/gitgoblin-mcp.mjs", import.meta.url);
await import(existsSync(source) ? source.href : bundle.href);
