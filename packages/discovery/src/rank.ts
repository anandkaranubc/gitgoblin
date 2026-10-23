/**
 * Keeps at most `maxPerKey` items per key in the top of the list; the rest are
 * moved to the end instead of being dropped, so the limit still fills.
 */
export function diversify<T>(items: T[], key: (item: T) => string, maxPerKey: number): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  const overflow: T[] = [];
  for (const item of items) {
    const k = key(item);
    const count = counts.get(k) ?? 0;
    if (count < maxPerKey) {
      counts.set(k, count + 1);
      kept.push(item);
    } else {
      overflow.push(item);
    }
  }
  return [...kept, ...overflow];
}
