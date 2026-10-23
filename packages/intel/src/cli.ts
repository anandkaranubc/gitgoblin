#!/usr/bin/env node
/**
 * Development CLI. The user-facing `gitgoblin` binary lives in packages/cli
 * and calls analyzeRepository() from this package.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { analyzeRepository, renderMarkdown } from "./index.ts";

const USAGE = `gitgoblin-intel analyze <owner/name | url> [options]

Options:
  --json             Print the AnalysisReport as JSON instead of Markdown
  --out <file>       Write the output to a file
  --max <n>          Maximum opportunities to report (default 15)
  --no-links         Skip HTTP checks of external links
  --no-deps          Skip OSV and registry checks of dependencies
  --no-cache         Ignore cached API responses
  --llm              Ask Claude for a second opinion on issue triage (costs money;
                     needs ANTHROPIC_API_KEY or \`ant auth login\`)
  --llm-model <id>   Model for --llm (default claude-opus-5-5, or GITGOBLIN_MODEL)
  --local <path>     Analyze an existing checkout instead of cloning
  --verbose          Progress on stderr
  -h, --help         This help

Needs a GitHub token in GITHUB_TOKEN or GH_TOKEN, or \`gh auth login\`, for
issue and pull request analysis; metadata and code analysis work without one.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
      max: { type: "string" },
      "no-links": { type: "boolean", default: false },
      "no-deps": { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      local: { type: "string" },
      llm: { type: "boolean", default: false },
      "llm-model": { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || command !== "analyze" || !target) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const started = Date.now();
  const report = await analyzeRepository(values.local ? { ...parseTarget(target), localPath: values.local } : target, {
    checkLinks: !values["no-links"],
    dependencyChecks: !values["no-deps"],
    maxOpportunities: values.max ? Number(values.max) : undefined,
    cacheTtlMs: values["no-cache"] ? 0 : undefined,
    llm: values.llm ? (values["llm-model"] ? { model: values["llm-model"] } : true) : false,
    log: values.verbose ? (m) => console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`) : undefined,
  });
  const text = values.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (values.out) {
    await writeFile(values.out, text);
    console.error(`wrote ${values.out}`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  return 0;
}

function parseTarget(target: string): { owner: string; name: string } {
  const m = /([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(target);
  if (!m) throw new Error(`Cannot parse ${target} as owner/name`);
  return { owner: m[1]!, name: m[2]! };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
