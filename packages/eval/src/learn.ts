/**
 * Does re-weighting discovery's signals generalise? A logistic fit on one set
 * of languages, scored on another, against the hand-tuned score and each
 * signal alone. Plain gradient descent on standardised features: small data,
 * no dependency.
 */
import { auc } from "./metrics.ts";

export interface Example {
  group: string;
  features: Record<string, number | undefined>;
  label: boolean;
  /** The score the hand-tuned ranking gives this example. */
  baseline: number;
}

export interface Fit {
  features: string[];
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Missing features become the training mean, which is zero after standardisation. */
export function fitLogistic(examples: Example[], features: string[], options: { steps?: number | undefined; rate?: number | undefined; l2?: number | undefined } = {}): Fit {
  const steps = options.steps ?? 2000;
  const rate = options.rate ?? 0.1;
  const l2 = options.l2 ?? 0.01;
  const means = features.map((f) => {
    const vals = examples.map((e) => e.features[f]).filter((v): v is number => v !== undefined);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  });
  const stds = features.map((f, i) => {
    const vals = examples.map((e) => e.features[f]).filter((v): v is number => v !== undefined);
    const variance = vals.length ? vals.reduce((s, v) => s + (v - means[i]!) ** 2, 0) / vals.length : 0;
    return Math.sqrt(variance) || 1;
  });
  const rows = examples.map((e) => features.map((f, i) => (e.features[f] === undefined ? 0 : (e.features[f]! - means[i]!) / stds[i]!)));
  const weights = features.map(() => 0);
  let bias = 0;
  for (let step = 0; step < steps; step++) {
    const gradW = features.map(() => 0);
    let gradB = 0;
    rows.forEach((x, n) => {
      const err = sigmoid(x.reduce((s, v, i) => s + v * weights[i]!, bias)) - (examples[n]!.label ? 1 : 0);
      x.forEach((v, i) => (gradW[i]! += err * v));
      gradB += err;
    });
    weights.forEach((w, i) => (weights[i] = w - rate * (gradW[i]! / rows.length + l2 * w)));
    bias -= rate * (gradB / rows.length);
  }
  return { features, weights, bias, means, stds };
}

export function predict(fit: Fit, features: Record<string, number | undefined>): number {
  const z = fit.features.reduce((s, f, i) => {
    const v = features[f];
    return s + (v === undefined ? 0 : ((v - fit.means[i]!) / fit.stds[i]!) * fit.weights[i]!);
  }, fit.bias);
  return sigmoid(z);
}

export interface HeldOutResult {
  group: string;
  n: number;
  positives: number;
  /** AUC of the fit trained on the other groups. */
  learned: number | undefined;
  /** AUC of the hand-tuned score. */
  baseline: number | undefined;
  /** AUC of each feature on its own (missing values score lowest). */
  single: Record<string, number | undefined>;
}

function aucOf(examples: Example[], score: (e: Example) => number): number | undefined {
  return auc(examples.filter((e) => e.label).map(score), examples.filter((e) => !e.label).map(score));
}

/** Leave-one-group-out: fit on every other group, score the held-out one. */
export function leaveOneGroupOut(examples: Example[], features: string[]): HeldOutResult[] {
  const groups = [...new Set(examples.map((e) => e.group))];
  return groups.map((group) => {
    const train = examples.filter((e) => e.group !== group);
    const test = examples.filter((e) => e.group === group);
    const fit = fitLogistic(train, features);
    return {
      group,
      n: test.length,
      positives: test.filter((e) => e.label).length,
      learned: aucOf(test, (e) => predict(fit, e.features)),
      baseline: aucOf(test, (e) => e.baseline),
      single: Object.fromEntries(features.map((f) => [f, aucOf(test, (e) => e.features[f] ?? Number.NEGATIVE_INFINITY)])),
    };
  });
}
