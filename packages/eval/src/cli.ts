#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { type BacktestDataset, evaluate, examplesFrom, fetchDataset, LEARN_FEATURES, rescore } from "./discovery-backtest.ts";
import { compareRescore } from "./compare.ts";
import { fitLogistic, leaveOneGroupOut } from "./learn.ts";
import { gradeIssues, type IntelBacktestDataset, type IssueGradingDataset, regradeDataset, runIntelBacktest } from "./intel-backtest.ts";
import { renderEvaluation, renderIntel, renderIssueGrading, renderKinds, renderLearning, renderSlices, renderTracker } from "./report.ts";
import { fetchKinds, type KindsDataset } from "./tracker-kinds.ts";

const USAGE = `usage:
  gitgoblin-eval discovery fetch --as-of YYYY-MM-DD [--window 120] [--languages typescript,python] [--per-language 80] [--seed 1] [--resume data/file.json [--recompute]] --out data/file.json
  gitgoblin-eval discovery evaluate data/file.json [--k 10] [--iterations 1000] [--include-uncovered] [--rescore]
      --rescore scores the stored as-of inputs with the discovery code checked out now
  gitgoblin-eval discovery learn data/file.json [--min-grade 1] [--rescore]
  gitgoblin-eval discovery slices data/file.json
  gitgoblin-eval discovery compare data/file.json   (stored scores against the discovery code checked out now, paired)
  gitgoblin-eval tracker data/file.json
  gitgoblin-eval tracker kinds data/file.json --out data/kinds.json   (live; samples merged outsider PRs and reads their files)
  gitgoblin-eval tracker kinds-report data/kinds.json
  gitgoblin-eval intel fetch --as-of YYYY-MM-DD --repos owner/name,owner/name --out data/file.json [--max 40]
  gitgoblin-eval intel report data/file.json
  gitgoblin-eval intel regrade data/file.json   (re-grades stored findings from the clones; rewrites the file)
  gitgoblin-eval intel issues data/file.json --out data/issues.json   (live; grades the accepted issue opportunities)
  gitgoblin-eval intel issues-report data/issues.json

Live fetches need a GitHub token (GITHUB_TOKEN or gh auth login). Responses are cached under packages/eval/.cache.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "as-of": { type: "string" },
    window: { type: "string", default: "120" },
    languages: { type: "string", default: "typescript,python,rust,go" },
    "per-language": { type: "string", default: "80" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    k: { type: "string", default: "10" },
    iterations: { type: "string", default: "1000" },
    cache: { type: "string" },
    repos: { type: "string" },
    max: { type: "string", default: "40" },
    "min-grade": { type: "string", default: "1" },
    resume: { type: "string" },
    recompute: { type: "boolean", default: false },
    "include-uncovered": { type: "boolean", default: false },
    rescore: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
    help: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

async function readDataset(path: string | undefined): Promise<BacktestDataset> {
  if (!path) fail("a dataset file is required");
  return JSON.parse(await readFile(path, "utf8")) as BacktestDataset;
}

const [command, sub, file] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

if (command === "discovery" && sub === "fetch") {
  if (!values["as-of"]) fail("--as-of is required");
  if (!values.out) fail("--out is required");
  const resume = values.resume ? await readDataset(values.resume) : undefined;
  const out = values.out;
  await mkdir(dirname(out), { recursive: true });
  const dataset = await fetchDataset({
    resume,
    recompute: values.recompute,
    concurrency: Number(values.concurrency),
    checkpoint: async (partial) => {
      await writeFile(out, JSON.stringify(partial, null, 1));
      console.error(`checkpoint: ${partial.rows.length} rows written to ${out}`);
    },
    asOf: values["as-of"],
    windowDays: Number(values.window),
    languages: values.languages.split(",").map((l) => l.trim()).filter(Boolean),
    perLanguage: Number(values["per-language"]),
    seed: Number(values.seed),
    cachePath: values.cache ?? new URL("../.cache/http-cache.sqlite", import.meta.url).pathname,
    log: (m) => console.error(m),
  });
  await writeFile(out, JSON.stringify(dataset, null, 1));
  console.error(`wrote ${dataset.rows.length} rows to ${out}`);
} else if (command === "discovery" && sub === "evaluate") {
  const stored = await readDataset(file);
  const dataset = values.rescore ? rescore(stored) : stored;
  console.log(renderEvaluation(dataset, evaluate(dataset, { k: Number(values.k), iterations: Number(values.iterations), includeUncovered: values["include-uncovered"] })));
} else if (command === "discovery" && sub === "learn") {
  const stored = await readDataset(file);
  const dataset = values.rescore ? rescore(stored) : stored;
  const examples = examplesFrom(dataset, Number(values["min-grade"]));
  console.log(renderLearning(leaveOneGroupOut(examples, LEARN_FEATURES), fitLogistic(examples, LEARN_FEATURES), Number(values["min-grade"])));
} else if (command === "discovery" && sub === "compare") {
  const c = compareRescore(await readDataset(file), { k: Number(values.k), iterations: Number(values.iterations) });
  const f = (x: number) => x.toFixed(3);
  console.log(`${c.repositories} repositories (${c.oddsPool} with three or more decided newcomer pull requests)`);
  console.log(`nDCG@${values.k}: ${f(c.ndcg.before)} -> ${f(c.ndcg.after)}, delta ${f(c.ndcg.delta.estimate)} [${f(c.ndcg.delta.lower)}, ${f(c.ndcg.delta.upper)}]`);
  console.log(`newcomer odds (Spearman): ${f(c.odds.before)} -> ${f(c.odds.after)}, delta ${f(c.odds.delta.estimate)} [${f(c.odds.delta.lower)}, ${f(c.odds.delta.upper)}]`);
} else if (command === "discovery" && sub === "slices") {
  console.log(renderSlices(await readDataset(file)));
} else if (command === "intel" && sub === "fetch") {
  if (!values["as-of"]) fail("--as-of is required");
  if (!values.out) fail("--out is required");
  if (!values.repos) fail("--repos is required");
  const cacheDir = new URL("../.cache/intel", import.meta.url).pathname;
  const dataset = await runIntelBacktest({
    repos: values.repos.split(",").map((r) => r.trim()).filter(Boolean),
    asOf: values["as-of"],
    cacheDir,
    cachePath: values.cache ?? new URL("../.cache/http-cache.sqlite", import.meta.url).pathname,
    maxOpportunities: Number(values.max),
    log: (m) => console.error(m),
  });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(dataset, null, 1));
  console.error(`wrote ${dataset.rows.length} rows to ${values.out}`);
} else if (command === "intel" && sub === "issues") {
  if (!file) fail("a dataset file is required");
  if (!values.out) fail("--out is required");
  const data = await gradeIssues(JSON.parse(await readFile(file, "utf8")) as IntelBacktestDataset, { cachePath: values.cache ?? new URL("../.cache/http-cache.sqlite", import.meta.url).pathname, log: (m) => console.error(m) });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(data, null, 1));
  console.log(renderIssueGrading(data));
} else if (command === "intel" && sub === "issues-report") {
  if (!file) fail("a dataset file is required");
  console.log(renderIssueGrading(JSON.parse(await readFile(file, "utf8")) as IssueGradingDataset));
} else if (command === "intel" && sub === "regrade") {
  if (!file) fail("a dataset file is required");
  const cacheDir = new URL("../.cache/intel", import.meta.url).pathname;
  const data = await regradeDataset(JSON.parse(await readFile(file, "utf8")) as IntelBacktestDataset, { cacheDir, cachePath: values.cache ?? new URL("../.cache/http-cache.sqlite", import.meta.url).pathname, log: (m) => console.error(m) });
  await writeFile(file, JSON.stringify(data, null, 1));
  console.log(renderIntel(data));
} else if (command === "intel" && sub === "report") {
  if (!file) fail("a dataset file is required");
  console.log(renderIntel(JSON.parse(await readFile(file, "utf8")) as IntelBacktestDataset));
} else if (command === "tracker" && sub === "kinds") {
  if (!values.out) fail("--out is required");
  const data = await fetchKinds(await readDataset(file), { cachePath: values.cache ?? new URL("../.cache/http-cache.sqlite", import.meta.url).pathname, log: (m) => console.error(m) });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(data, null, 1));
  console.log(renderKinds(data));
} else if (command === "tracker" && sub === "kinds-report") {
  if (!file) fail("a dataset file is required");
  console.log(renderKinds(JSON.parse(await readFile(file, "utf8")) as KindsDataset));
} else if (command === "tracker") {
  const dataset = await readDataset(sub);
  console.log(renderTracker(dataset));
} else {
  fail(`unknown command: ${[command, sub].filter(Boolean).join(" ")}`);
}
