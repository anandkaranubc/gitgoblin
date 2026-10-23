import { ciHealthAnalyzer } from "./ci-health.ts";
import { ciRotAnalyzer } from "./ci-rot.ts";
import { dependenciesAnalyzer } from "./dependencies.ts";
import { deprecationsAnalyzer } from "./deprecations.ts";
import { docsDriftAnalyzer } from "./docs-drift.ts";
import { hygieneAnalyzer } from "./hygiene.ts";
import { issuesAnalyzer } from "./issues.ts";
import { linksAnalyzer } from "./links.ts";
import { stalePrsAnalyzer } from "./stale-prs.ts";
import { techDebtAnalyzer } from "./tech-debt.ts";
import { testGapsAnalyzer } from "./test-gaps.ts";
import type { Analyzer } from "./types.ts";

export type { Analyzer, Finding, FindingSignals } from "./types.ts";

/** Default analyzers, in the order they run. */
export const ANALYZERS: readonly Analyzer[] = [
  issuesAnalyzer,
  stalePrsAnalyzer,
  ciHealthAnalyzer,
  ciRotAnalyzer,
  deprecationsAnalyzer,
  dependenciesAnalyzer,
  docsDriftAnalyzer,
  linksAnalyzer,
  testGapsAnalyzer,
  techDebtAnalyzer,
  hygieneAnalyzer,
];
