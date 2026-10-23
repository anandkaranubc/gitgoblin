/**
 * Ranking and classification metrics, plus a bootstrap for confidence
 * intervals. Everything here is pure so it can be unit-tested with small
 * hand-computed cases.
 */

function gain(grade: number): number {
  return 2 ** grade - 1;
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);
}

/**
 * Normalized discounted cumulative gain of the top `k` of a ranked list of
 * grades. The ideal ordering is taken from the whole list, so pushing a
 * relevant item below `k` costs the full gain.
 */
export function ndcgAtK(rankedGrades: number[], k: number): number {
  const ideal = dcg([...rankedGrades].sort((a, b) => b - a).slice(0, k));
  if (ideal === 0) return 0;
  return dcg(rankedGrades.slice(0, k)) / ideal;
}

/** Share of the top `k` that are hits. Zero when the list is empty. */
export function precisionAtK(rankedHits: boolean[], k: number): number {
  const top = rankedHits.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter(Boolean).length / top.length;
}

/** Ranks with ties averaged, 1-based. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let m = i; m <= j; m++) out[order[m]!.i] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; undefined when either input is constant or too short. */
export function spearman(a: number[], b: number[]): number | undefined {
  if (a.length !== b.length || a.length < 2) return undefined;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    const da = ra[i]! - ma;
    const db = rb[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return undefined;
  return cov / Math.sqrt(va * vb);
}

/** Area under the ROC curve by the Mann-Whitney statistic; ties count half. */
export function auc(positives: number[], negatives: number[]): number | undefined {
  if (positives.length === 0 || negatives.length === 0) return undefined;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

export interface BootstrapResult {
  /** The statistic on the full sample. */
  estimate: number;
  /** 2.5th and 97.5th percentiles over resamples. */
  lower: number;
  upper: number;
  iterations: number;
}

/** Deterministic PRNG (mulberry32), the same one discovery uses for `explore`. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap over item indices. `statistic` receives the indices of
 * one resample (with replacement), so paired comparisons (method A minus
 * method B on the same repositories) are one statistic.
 */
export function bootstrap(
  n: number,
  statistic: (indices: number[]) => number,
  options: { iterations?: number | undefined; seed?: number | undefined } = {},
): BootstrapResult {
  const iterations = options.iterations ?? 1000;
  const random = seededRandom(options.seed ?? 1);
  const all = Array.from({ length: n }, (_, i) => i);
  const estimate = statistic(all);
  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const idx = Array.from({ length: n }, () => Math.floor(random() * n));
    samples.push(statistic(idx));
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))]!;
  return { estimate, lower: at(0.025), upper: at(0.975), iterations };
}
