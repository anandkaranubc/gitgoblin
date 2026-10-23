const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function hoursBetween(a: string | Date, b: string | Date): number {
  return (toMs(b) - toMs(a)) / HOUR;
}

export function daysBetween(a: string | Date, b: string | Date): number {
  return (toMs(b) - toMs(a)) / DAY;
}

export function daysAgo(then: string | Date, now: Date): number {
  return daysBetween(then, now);
}

export function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY).toISOString();
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function toMs(value: string | Date): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}
