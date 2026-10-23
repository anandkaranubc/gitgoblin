import { describe, expect, it } from "vitest";
import { hasPwnRequest, matchCiRules } from "../src/analyzers/ci-rot.ts";

describe("CI rot rules", () => {
  it("flags retired runners, dead action versions and disabled commands, not comments", () => {
    const wf = `
name: ci
on: [push]
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-20.04, ubuntu-latest, macos-13]
        python-version: ["3.7", "3.12"]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
      # - uses: actions/upload-artifact@v2  (commented out)
      - uses: actions/upload-artifact@v3
      - uses: actions/cache@v3.2.0
      - run: echo "::set-output name=x::1"
`;
    const ids = matchCiRules("ci.yml", wf).map((m) => `${m.rule.id}@${m.line}`);
    expect(ids).toEqual([
      "retired-runner@9", "python-eol-on-latest@10", "node16-actions@12", "artifact-v3@15", "cache-v2@16", "set-output@17",
    ]);
    expect(ids.some((i) => i.startsWith("artifact-v3@14"))).toBe(false);
  });

  it("does not flag current versions or similar names", () => {
    const wf = `
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v6
        with:
          python-version: "3.12"
      - uses: actions/upload-artifact@v4
      - uses: actions/cache@v4
      - run: echo "value=1" >> "$GITHUB_OUTPUT"
      - run: docker run ubuntu-20.04-image
`;
    expect(matchCiRules("ci.yml", wf)).toEqual([]);
  });

  it("detects pull_request_target with PR head checkout", () => {
    const risky = `on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
    expect(hasPwnRequest(risky)?.line).toBe(8);
    const safe = `on: [pull_request]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
    expect(hasPwnRequest(safe)).toBeUndefined();
  });
});
