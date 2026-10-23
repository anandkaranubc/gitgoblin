#!/usr/bin/env node
// Entry point for the installed `gitgoblin` command and for a clone of the repository.
import { existsSync } from "node:fs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  process.stderr.write(`gitgoblin needs Node.js 24 or newer; this is ${process.version}.\n`);
  process.exit(1);
}

// A clone runs the TypeScript source on Node 24; the published package has no src/ and ships the bundle instead.
const source = new URL("../src/bin.ts", import.meta.url);
const bundle = new URL("../dist/gitgoblin.mjs", import.meta.url);
await import(existsSync(source) ? source.href : bundle.href);
