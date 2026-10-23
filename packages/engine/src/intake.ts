import { z } from "zod";
import { TaskSchema, type Task, type TaskInput } from "./types.ts";

/**
 * Loose projections of `@gitgoblin/intel`'s RepositoryProfile and ContributionOpportunity.
 * Only the fields the engine reads are declared; everything else passes through untouched,
 * so intel can grow its schemas without breaking the engine.
 */
const RepoRefProjection = z
  .object({
    host: z.string().optional(),
    owner: z.string(),
    name: z.string(),
    ref: z.string().optional(),
    localPath: z.string().optional(),
  })
  .loose();

const ProfileProjection = z
  .object({
    repo: RepoRefProjection,
    headSha: z.string().optional(),
    defaultBranch: z.string().optional(),
    ecosystems: z
      .array(
        z
          .object({
            commands: z.record(z.string(), z.string().optional()).optional(),
          })
          .loose(),
      )
      .optional(),
    conventions: z
      .object({
        commitStyle: z.string().optional(),
        branchNaming: z.string().optional(),
        recentCommitSubjects: z.array(z.string()).optional(),
        testFramework: z.string().optional(),
        formatter: z.string().optional(),
      })
      .loose()
      .optional(),
    welcomeness: z
      .object({
        rules: z
          .object({
            contributingPath: z.string().optional(),
            pullRequestTemplatePath: z.string().optional(),
            requiresIssueFirst: z.boolean().optional(),
            requiresTests: z.boolean().optional(),
            requiresChangelog: z.boolean().optional(),
            rejectedChanges: z.array(z.string()).optional(),
            cla: z.boolean().optional(),
            dco: z.boolean().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
    instructionFiles: z.array(z.string()).optional(),
  })
  .loose();

const OpportunityProjection = z
  .object({
    id: z.string(),
    repo: RepoRefProjection.optional(),
    kind: z.string().optional(),
    title: z.string(),
    summary: z.string().optional(),
    issue: z
      .object({
        number: z.number(),
        url: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        inFlight: z.boolean().optional(),
      })
      .loose()
      .optional(),
    files: z.array(z.string()).optional(),
    approach: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    etiquette: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    effort: z.enum(["trivial", "small", "medium", "large"]).optional(),
  })
  .loose();

/** Removes invisible and bidirectional control characters that can hide instructions in issue text. */
export function sanitizeText(text: string): string {
  return text.replace(/[​-‏‪-‮⁠-⁤﻿]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function sanitizeAll(values: string[] | undefined): string[] {
  return (values ?? []).map(sanitizeText);
}

function hostName(host: string | undefined): string {
  if (!host || host === "github") return "github.com";
  return host;
}

/** Picks the first ecosystem command set that knows how to run tests, else the first one. */
function mergeCommands(ecosystems: { commands?: Record<string, string | undefined> | undefined }[] | undefined) {
  const sets = (ecosystems ?? []).map((e) => e.commands ?? {});
  const chosen = sets.find((c) => c["test"]) ?? sets[0] ?? {};
  const pick = (key: string) => (typeof chosen[key] === "string" && chosen[key] ? chosen[key] : undefined);
  return {
    install: pick("install"),
    build: pick("build"),
    test: pick("test"),
    lint: pick("lint"),
    typecheck: pick("typecheck"),
    format: pick("format"),
  };
}

/** Builds the engine's Task from intel's RepositoryProfile and ContributionOpportunity. */
export function taskFromIntel(profileInput: unknown, opportunityInput: unknown): Task {
  const profile = ProfileProjection.parse(profileInput);
  const opp = OpportunityProjection.parse(opportunityInput);
  // The opportunity names the repo; the profile knows where its checkout is.
  const repo = { ...profile.repo, ...opp.repo };
  const host = hostName(repo.host);
  const rules = profile.welcomeness?.rules ?? {};

  const input: TaskInput = {
    id: opp.id,
    repo: {
      host,
      owner: repo.owner,
      name: repo.name,
      cloneUrl: `https://${host}/${repo.owner}/${repo.name}.git`,
      ...(repo.localPath ? { localPath: repo.localPath } : {}),
      ...(profile.defaultBranch ? { defaultBranch: profile.defaultBranch } : {}),
      ...(profile.headSha ? { headSha: profile.headSha } : {}),
    },
    commands: mergeCommands(profile.ecosystems),
    conventions: {
      ...(profile.conventions?.commitStyle ? { commitStyle: profile.conventions.commitStyle } : {}),
      ...(profile.conventions?.branchNaming ? { branchNaming: profile.conventions.branchNaming } : {}),
      recentCommitSubjects: sanitizeAll(profile.conventions?.recentCommitSubjects),
      ...(profile.conventions?.testFramework ? { testFramework: profile.conventions.testFramework } : {}),
      ...(profile.conventions?.formatter ? { formatter: profile.conventions.formatter } : {}),
    },
    rules: {
      ...(rules.contributingPath ? { contributingPath: rules.contributingPath } : {}),
      ...(rules.pullRequestTemplatePath ? { prTemplatePath: rules.pullRequestTemplatePath } : {}),
      instructionFiles: profile.instructionFiles ?? [],
      rejectedChanges: sanitizeAll(rules.rejectedChanges),
      ...(rules.requiresIssueFirst !== undefined ? { requiresIssueFirst: rules.requiresIssueFirst } : {}),
      ...(rules.requiresTests !== undefined ? { requiresTests: rules.requiresTests } : {}),
      ...(rules.requiresChangelog !== undefined ? { requiresChangelog: rules.requiresChangelog } : {}),
      ...(rules.cla !== undefined ? { cla: rules.cla } : {}),
      ...(rules.dco !== undefined ? { dco: rules.dco } : {}),
    },
    kind: opp.kind ?? "issue",
    title: sanitizeText(opp.title),
    summary: sanitizeText(opp.summary ?? ""),
    ...(opp.issue
      ? {
          issue: {
            number: opp.issue.number,
            ...(opp.issue.url ? { url: opp.issue.url } : {}),
            ...(opp.issue.title ? { title: sanitizeText(opp.issue.title) } : {}),
            ...(opp.issue.body ? { body: sanitizeText(opp.issue.body) } : {}),
            labels: opp.issue.labels ?? [],
            inFlight: opp.issue.inFlight ?? false,
          },
        }
      : {}),
    files: opp.files ?? [],
    approach: sanitizeAll(opp.approach),
    acceptanceCriteria: sanitizeAll(opp.acceptanceCriteria),
    etiquette: sanitizeAll(opp.etiquette),
    risks: sanitizeAll(opp.risks),
    ...(opp.effort ? { effort: opp.effort } : {}),
  };
  return TaskSchema.parse(input);
}

/** Parses a Task written by hand or by a previous run. */
export function parseTask(input: unknown): Task {
  return TaskSchema.parse(input);
}
