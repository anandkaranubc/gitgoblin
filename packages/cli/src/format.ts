import { styleText } from "node:util";
import type { DiscoveryResult, Reason, SignalName } from "@gitgoblin/core";
import { SIGNAL_DESCRIPTIONS, SIGNAL_NAMES } from "@gitgoblin/core";

export interface Style {
  color: boolean;
}

type Tone = "bold" | "dim" | "green" | "red" | "cyan" | "yellow";

function paint(style: Style, tone: Tone, text: string): string {
  return style.color ? styleText(tone, text) : text;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function headline(result: DiscoveryResult, style: Style): string {
  const { repo } = result;
  const meta = [`★ ${compact(repo.stars)}`, repo.language, repo.license].filter(Boolean).join(" · ");
  return `${paint(style, "bold", `${repo.owner}/${repo.name}`)}  ${paint(style, "dim", meta)}  ${paint(style, "cyan", `score ${result.score.toFixed(2)}`)}`;
}

/** The strongest reasons: up to three that helped and the one that hurt most. */
export function highlightReasons(reasons: Reason[], positive = 3, negative = 1): Reason[] {
  const sorted = [...reasons].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return [...sorted.filter((r) => r.weight > 0).slice(0, positive), ...sorted.filter((r) => r.weight < 0).slice(0, negative)];
}

export function formatResults(results: DiscoveryResult[], style: Style): string {
  if (results.length === 0) return "No repositories matched. Try fewer filters or another goal.";
  const blocks = results.map((result, index) => {
    const lines = [`${String(index + 1).padStart(2)}. ${headline(result, style)}`];
    if (result.repo.description) lines.push(`    ${truncate(result.repo.description, 100)}`);
    lines.push(`    ${paint(style, "dim", result.repo.url)}`);
    for (const reason of highlightReasons(result.reasons)) {
      const sign = reason.weight > 0 ? paint(style, "green", "+") : paint(style, "red", "−");
      lines.push(`    ${sign} ${reason.detail}`);
    }
    for (const issue of (result.issues ?? []).slice(0, 2)) {
      lines.push(`    ${paint(style, "yellow", "issue")} #${issue.number} ${truncate(issue.title, 80)}`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

function bar(value: number | undefined): string {
  if (value === undefined) return "  unknown ";
  const filled = Math.round(value * 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function formatExplanation(result: DiscoveryResult, style: Style): string {
  const lines = [headline(result, style), `goal: ${result.goal}`, ""];
  const byName = new Map<string, Reason>(result.reasons.filter((r) => r.signal !== "filter" && r.signal !== "jitter").map((r) => [r.signal, r]));
  for (const name of SIGNAL_NAMES) {
    const value = result.signals[name as SignalName];
    const reason = byName.get(name);
    const weight = reason ? ` ${reason.weight >= 0 ? "+" : "−"}${Math.abs(reason.weight).toFixed(2)}` : "      ";
    const detail = reason?.detail ?? SIGNAL_DESCRIPTIONS[name as SignalName];
    lines.push(`${name.padEnd(21)} ${bar(value)} ${value === undefined ? "   " : value.toFixed(2)}${paint(style, "dim", weight)}  ${detail}`);
  }
  const extras = result.reasons.filter((r) => r.signal === "filter" || r.signal === "jitter" || !byName.has(r.signal) || byName.get(r.signal) !== r);
  if (extras.length > 0) {
    lines.push("");
    for (const reason of extras) lines.push(`${reason.weight >= 0 ? paint(style, "green", "+") : paint(style, "red", "−")} ${reason.detail}`);
  }
  if (result.issues?.length) {
    lines.push("", "starter issues:");
    for (const issue of result.issues) lines.push(`  #${issue.number} ${truncate(issue.title, 90)}  ${paint(style, "dim", issue.url)}`);
  }
  return lines.join("\n");
}
