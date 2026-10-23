#!/usr/bin/env node
// Summarise AnalysisReport JSON files into one table for calibration review.
// Usage: node scripts/summarize-reports.mjs <dir-or-files...>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const inputs = process.argv.slice(2).flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".json")).map((f) => join(p, f)) : [p]));
for (const file of inputs) {
  let r;
  try { r = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
  if (!r?.profile) continue;
  const p = r.profile;
  const kinds = {};
  for (const o of r.opportunities) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  const a = p.activity;
  console.log(`\n== ${p.repo.owner}/${p.repo.name}  ${p.nature}  ${p.welcomeness.level} (${p.welcomeness.score})  ${p.ecosystems.map((e) => e.name).join("+") || "no ecosystem"}  ${(r.budget.totalMs / 1000).toFixed(1)}s${r.budget.truncated ? " truncated" : ""}`);
  console.log(`   merge ${a.externalPrMergeRate ?? "?"} (n=${a.sampleSizes.externalPullRequests}) issue ${a.medianIssueResponseHours === undefined ? "?" : Math.round(a.medianIssueResponseHours / 24) + "d"} pr ${a.medianPrResponseHours === undefined ? "?" : Math.round(a.medianPrResponseHours / 24) + "d"}; central: ${p.structure.centralFiles.slice(0, 3).map((c) => c.path).join(", ") || "-"}`);
  console.log(`   kinds: ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
  for (const o of r.opportunities.slice(0, 4)) console.log(`   ${o.score.toFixed(2)} ${o.kind.padEnd(15)} ${o.title.slice(0, 90)}`);
  for (const n of r.budget.notes.filter((n) => !/^issues passed over/.test(n))) console.log(`   note: ${n.slice(0, 140)}`);
}
