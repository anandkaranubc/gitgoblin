#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parseCheckIsolation, parseCloneDepth, parseCostLimit, parseEffort, unsandboxedAllowed } from "./flags.ts";
import { RunJournal } from "./journal.ts";
import { publishRun, runContribution } from "./orchestrator.ts";

const USAGE = `gitgoblin-engine: turn one validated opportunity into a reviewable pull request.

Usage:
  gitgoblin-engine run --task task.json [options]
  gitgoblin-engine run --report analysis.json --opportunity <id> [options]
  gitgoblin-engine show <runId> [--workdir DIR]
  gitgoblin-engine publish <runId> [--workdir DIR] [--dry-run] [--ready] [--yes]

Run options:
  --workdir DIR       where runs/<id>/ live (default: ./.gitgoblin)
  --max-cost USD      stop when the estimated spend passes this (default: 10)
  --model NAME        model for every phase (default: the Claude Code default)
  --effort LEVEL      low | medium | high | xhigh | max
  --confirm-plan      pause after planning and ask before implementing
  --skip-install      do not run the repository's install command
  --no-sandbox        rely on hooks only (not recommended; also needs GITGOBLIN_UNSAFE_NO_SANDBOX=1)
  --clone-depth N     shallow clone with N commits of history, for very large repositories
  --check-isolation   how the repository's own commands run on this machine: auto (default: OS
                      sandbox when available), sandbox (required), strict (required, and your home
                      directory is hidden except toolchains and caches), none

Publishing never happens during run. It pushes with your gh login and opens a draft PR
only after you confirm.`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === "run") {
    const { values } = parseArgs({
      args: rest,
      options: {
        task: { type: "string" },
        report: { type: "string" },
        opportunity: { type: "string" },
        workdir: { type: "string" },
        "max-cost": { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "confirm-plan": { type: "boolean" },
        "skip-install": { type: "boolean" },
        "no-sandbox": { type: "boolean" },
        "check-isolation": { type: "string" },
        "clone-depth": { type: "string" },
      },
    });
    let input;
    if (values.task) {
      input = { task: JSON.parse(readFileSync(values.task, "utf8")) };
    } else if (values.report && values.opportunity) {
      const report = JSON.parse(readFileSync(values.report, "utf8")) as { profile: unknown; opportunities: { id: string }[] };
      const opportunity = report.opportunities.find((o) => o.id === values.opportunity);
      if (!opportunity) fail(`opportunity ${values.opportunity} not found in ${values.report}`);
      input = { profile: report.profile, opportunity };
    } else {
      fail("run needs --task FILE or --report FILE --opportunity ID");
    }
    const effort = parseEffort(values.effort);
    const checkIsolation = parseCheckIsolation(values["check-isolation"]);
    const cloneDepth = parseCloneDepth(values["clone-depth"]);
    if (values["no-sandbox"]) {
      if (!unsandboxedAllowed()) fail("--no-sandbox runs the agent's commands on this machine with only text-matching hooks in the way; set GITGOBLIN_UNSAFE_NO_SANDBOX=1 as well if that is really what you want");
      process.stderr.write("warning: --no-sandbox: the agent's commands run on this machine with only text-matching hooks between them and your files\n");
    }
    const result = await runContribution(input, {
      workdir: path.resolve(values.workdir ?? ".gitgoblin"),
      ...(values["max-cost"] ? { limits: { maxCostUsd: parseCostLimit(values["max-cost"]) } } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(effort ? { effort } : {}),
      ...(values["skip-install"] ? { skipInstall: true } : {}),
      ...(values["no-sandbox"] ? { isolation: "none" as const } : {}),
      ...(checkIsolation ? { checkIsolation } : {}),
      ...(cloneDepth ? { cloneDepth } : {}),
      ...(values["confirm-plan"]
        ? {
            approvePlan: async (plan, context) => {
              process.stderr.write(`\nPlan: ${plan.goal}\n${plan.steps.map((s) => `  - ${s}`).join("\n")}\nFiles: ${[...plan.filesToModify, ...plan.filesToCreate].join(", ")}\n`);
              if (context?.install) process.stderr.write(`Install ${context.install.timedOut ? "timed out" : `failed (exit ${context.install.exitCode})`}; the change may not be verifiable. Log: ${context.install.logPath}\n`);
              const failing = (context?.baseline ?? []).filter((c) => c.status !== "pass");
              if (failing.length) process.stderr.write(`Baseline checks not passing before any change: ${failing.map((c) => `${c.name} (${c.status})`).join(", ")}\n`);
              return confirm("Implement this plan?");
            },
          }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\nReport: ${path.join(result.runDir, "report.md")}\n`);
    if (result.status === "awaiting_approval") process.stderr.write(`Publish with: gitgoblin-engine publish ${result.runId}${values.workdir ? ` --workdir ${values.workdir}` : ""}\n`);
    return;
  }

  if (command === "show" || command === "publish") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { workdir: { type: "string" }, "dry-run": { type: "boolean" }, ready: { type: "boolean" }, yes: { type: "boolean" } },
    });
    const runId = positionals[0];
    if (!runId) fail(`${command} needs a run id`);
    const workdir = path.resolve(values.workdir ?? ".gitgoblin");
    const journal = RunJournal.open(workdir, runId);
    if (command === "show") {
      process.stdout.write(journal.readText("report.md") ?? fail(`no report for run ${runId}`));
      return;
    }
    const title = journal.readText("pr-title.txt")?.trim() ?? fail(`run ${runId} has nothing to publish`);
    process.stderr.write(`About to push and open a ${values.ready ? "ready" : "draft"} pull request: ${title}\nRead ${journal.pathFor("pr.md")} and ${journal.pathFor("diff.patch")} first.\n`);
    if (!values["dry-run"] && !values.yes && !(await confirm("Publish now?"))) {
      process.stderr.write("Not published.\n");
      return;
    }
    const published = await publishRun(runId, {
      workdir,
      approved: true,
      draft: !values.ready,
      ...(values["dry-run"] ? { dryRun: true } : {}),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (values["dry-run"]) process.stdout.write(`${published.commands.join("\n")}\n`);
    else process.stdout.write(`${published.url}\n`);
    return;
  }

  fail(`unknown command ${command}\n\n${USAGE}`);
}

main(process.argv.slice(2)).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
