import { describe, expect, it } from "vitest";
import { parseCheckIsolation, parseCostLimit, parseEffort } from "../src/flags.ts";

describe("parseCostLimit", () => {
  it("accepts positive numbers", () => {
    expect(parseCostLimit("5")).toBe(5);
    expect(parseCostLimit("0.5")).toBe(0.5);
  });
  it.each(["", "abc", "NaN", "-1", "0", "Infinity", "1e400"])("rejects %s, which would make the limit unbounded or meaningless", (v) => {
    expect(() => parseCostLimit(v)).toThrow(/max-cost/);
  });
});

describe("parseEffort", () => {
  it("accepts the known levels and nothing else", () => {
    expect(parseEffort("high")).toBe("high");
    expect(parseEffort(undefined)).toBeUndefined();
    expect(() => parseEffort("turbo")).toThrow(/effort/);
  });
});

describe("parseCheckIsolation", () => {
  it("accepts auto, sandbox and none", () => {
    expect(parseCheckIsolation("sandbox")).toBe("sandbox");
    expect(parseCheckIsolation(undefined)).toBeUndefined();
    expect(() => parseCheckIsolation("maybe")).toThrow(/check-isolation/);
  });
});
