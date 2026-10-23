export const DAY_MS = 86_400_000;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 1 at zero, 0.5 at `halfLife`, approaching 0. Used for "how recent" signals. */
export function decay(value: number, halfLife: number): number {
  return value <= 0 ? 1 : 2 ** (-value / halfLife);
}

/** Logarithmic 0..1 scale: 0 at zero, 1 at `max` and above. Tames heavy-tailed counts. */
export function logScale(value: number, max: number): number {
  if (value <= 0) return 0;
  return clamp01(Math.log10(1 + value) / Math.log10(1 + max));
}

export function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  return Math.max(0, (now - time) / DAY_MS);
}

/** Mean of the defined values, or undefined when there are none. */
export function average(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce((sum, v) => sum + v, 0) / known.length;
}

/** Deterministic PRNG (mulberry32). Same seed, same sequence, on every platform. */
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

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function formatDays(days: number): string {
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 45) return `${Math.round(days)} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = days / 365;
  return `${years < 10 ? years.toFixed(1).replace(/\.0$/, "") : Math.round(years)} years ago`;
}
