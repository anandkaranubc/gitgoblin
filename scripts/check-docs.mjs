#!/usr/bin/env node
// Checks that every relative link and heading anchor in the repository's
// Markdown files points at something that exists. No dependencies.
// Usage: node scripts/check-docs.mjs [root]

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
// .worktrees holds other branches' checkouts (AGENTS.md), which are checked on their own branches.
const skipDirs = new Set(["node_modules", "dist", "coverage", ".git", ".remember", ".cache", ".worktrees"]);

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) yield* markdownFiles(join(dir, entry.name));
    } else if (entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

// GitHub's heading-to-anchor rule: lowercase, drop punctuation, spaces to hyphens.
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*_~[\]()!]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headingAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function* links(text) {
  const clean = stripCode(text);
  // [label](target) and [label]: target. Images use the same bracket syntax.
  for (const m of clean.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\[[^\]]+\]:\s*(\S+)/gm)) {
    yield m[1] ?? m[2];
  }
  // Raw HTML such as <img src>, <source srcset> and <a href>.
  for (const m of clean.matchAll(/\b(?:src|srcset|href)="([^"\s]+)"/g)) yield m[1];
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, headingAnchors(readFileSync(file, "utf8")));
  return anchorCache.get(file);
}

const problems = [];
let checked = 0;

for (const file of markdownFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const target of links(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, etc.
    checked++;
    const [pathPart, fragment] = target.split("#");
    const resolved = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    const where = `${relative(root, file)} -> ${target}`;
    if (!existsSync(resolved)) {
      problems.push(`${where}: file not found`);
      continue;
    }
    if (fragment && statSync(resolved).isFile() && resolved.endsWith(".md") && !anchorsOf(resolved).has(fragment)) {
      problems.push(`${where}: no heading matches #${fragment}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken link(s) in ${checked} checked.`);
  process.exit(1);
}
console.log(`docs ok: ${checked} relative links checked.`);
