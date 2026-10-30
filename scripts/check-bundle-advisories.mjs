#!/usr/bin/env node
// Fails when a package a published bundle inlines has a high or critical advisory. The release's
// `npm audit --omit=dev` leaves out packages declared as devDependencies because the bundle inlines
// them (the MCP SDK, commander); the bundle's notices file names every inlined package and version.
//
//   npm audit --json > audit.json; node scripts/check-bundle-advisories.mjs <THIRD_PARTY_NOTICES.md> audit.json
import { readFileSync } from "node:fs";

const [noticesPath, auditPath] = process.argv.slice(2);
if (!noticesPath || !auditPath) {
  console.error("usage: node scripts/check-bundle-advisories.mjs <THIRD_PARTY_NOTICES.md> <npm audit --json output>");
  process.exit(2);
}
const inlined = new Map([...readFileSync(noticesPath, "utf8").matchAll(/^## (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]));
const report = JSON.parse(readFileSync(auditPath, "utf8"));
// npm audit exits non-zero on findings and on failures alike; only a report says which.
if (!report.vulnerabilities) {
  console.error(`npm audit gave no report: ${JSON.stringify(report.error ?? report).slice(0, 500)}`);
  process.exit(1);
}
const found = [];
for (const v of Object.values(report.vulnerabilities)) {
  if (!inlined.has(v.name) || !["high", "critical"].includes(v.severity)) continue;
  // The same package can be installed at several versions; only the one the bundle inlines counts.
  for (const node of v.nodes) if (JSON.parse(readFileSync(`${node}/package.json`, "utf8")).version === inlined.get(v.name)) found.push(`${v.name}@${inlined.get(v.name)}`);
}
for (const f of found) console.log(`::error::the bundle inlines ${f}, which has a high-severity advisory`);
console.log(`${inlined.size} inlined packages checked, ${found.length} with a high-severity advisory`);
process.exit(found.length ? 1 : 0);
