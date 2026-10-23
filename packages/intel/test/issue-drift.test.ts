import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalysisContext } from "../src/context.ts";
import type { IssueSample } from "../src/github/types.ts";
import { applyIssueDrift, assessIssueDrift, permalinks, quotedCodeLines, tracebackFrames } from "../src/analyzers/issue-drift.ts";
import type { Finding } from "../src/analyzers/types.ts";
import { openRepo } from "../src/git/repo.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";

const BEFORE = "def before_log(logger, log_level):\n    def log_it(retry_state):\n        if retry_state.fn is None:\n            fn_name = '<unknown>'  # can't really happen\n        else:\n            fn_name = retry_state.fn.__name__\n        logger.log(log_level, fn_name)\n    return log_it\n";
const AFTER = "def before_log(logger, log_level):\n    def log_it(retry_state):\n        fn_name = retry_state.get_fn_name()\n        logger.log(log_level, fn_name)\n    return log_it\n";

function issue(body: string, createdAt = "2025-06-01T00:00:00Z"): IssueSample {
  return {
    number: 511, url: "https://github.com/o/r/issues/511", title: "Unreachable code in before_log reached", body,
    createdAt, updatedAt: createdAt, labels: [], assignees: [], commentCount: 0, reactions: 0, author: null, authorAssociation: "NONE",
    comments: [], linkedPrs: [], locked: false,
  } as unknown as IssueSample;
}

function finding(): Finding {
  return {
    kind: "issue", clusterKey: "issue:511", title: "Fix #511", summary: "", evidence: [], files: [], effort: "small", skills: [], approach: [], acceptanceCriteria: [], risks: [],
    signals: { value: 0.5, valueReason: "", feasibility: 0.5, feasibilityReason: "", confidence: 0.6, confidenceReason: "inferred from the issue text alone" },
  };
}

describe("quoted code extraction", () => {
  it("keeps code-shaped lines from fenced blocks and drops prompts, output and bare imports", () => {
    const body = "Repro:\n```python\nimport tenacity\nfrom tenacity import retry\n>>> retry()\n$ pip install tenacity\n        if retry_state.fn is None:\nTraceback (most recent call last):\nfn_name = '<unknown>'  # can't really happen\n```\n";
    expect(quotedCodeLines(body)).toEqual(["if retry_state.fn is None:", "fn_name = '<unknown>'  # can't really happen"]);
  });

  it("ignores inline triple-backtick spans and frames without a source line", () => {
    const body = "Use ```compute()``` here.\nIt fails because `compute()` returns None, honestly.\n```python\nresult = compute(value, flag=True)\n```\n~~~\nother = helper(value, 3)\n~~~\n";
    expect(quotedCodeLines(body)).toEqual(["result = compute(value, flag=True)", "other = helper(value, 3)"]);
    const trace = 'Traceback (most recent call last):\n  File "/x/a.py", line 1, in f\n  File "/x/b.py", line 2, in g\n    value = g(1)\n';
    expect(tracebackFrames(trace)).toEqual([{ path: "/x/b.py", line: "value = g(1)" }]);
  });

  it("reads Python traceback frames with their source lines", () => {
    const body = 'Traceback (most recent call last):\n  File "/usr/lib/python3.12/site-packages/tenacity/before.py", line 40, in log_it\n    fn_name = retry_state.fn.__name__\nAttributeError: x\n';
    expect(tracebackFrames(body)).toEqual([{ path: "/usr/lib/python3.12/site-packages/tenacity/before.py", line: "fn_name = retry_state.fn.__name__" }]);
  });
});

describe("assessIssueDrift", () => {
  let fixture: FixtureRepo;
  let ctx: AnalysisContext;

  beforeAll(async () => {
    fixture = await FixtureRepo.create();
    await fixture.commit({ files: { "tenacity/before.py": BEFORE, "README.md": "# t\n" }, message: "initial", date: "2025-01-01T00:00:00Z" });
    await fixture.commit({ files: { "tenacity/before.py": AFTER }, message: "Use get_fn_name in before_log (#597)", date: "2026-02-20T00:00:00Z" });
    const repo = openRepo(fixture.dir);
    const files = (await repo.lsFiles()).map((path) => ({ path, vendored: false }));
    ctx = { repo, ref: { host: "github.com", owner: "o", name: "r" }, inventory: { files, byPath: new Map(files.map((f) => [f.path, f])) }, nowIso: "2026-10-22T00:00:00Z" } as unknown as AnalysisContext;
  });

  afterAll(() => fixture.cleanup());

  it("flags quoted code that existed at filing time and is gone at HEAD", async () => {
    const body = "In `tenacity/before.py`:\n```python\n        if retry_state.fn is None:\n            fn_name = '<unknown>'  # can't really happen\n```\nbut it does happen.";
    const drift = await assessIssueDrift(ctx, issue(body), ["tenacity/before.py"]);
    expect(drift?.gone.map((g) => g.file)).toEqual(["tenacity/before.py", "tenacity/before.py"]);
    expect(drift?.commits).toHaveLength(1);
    const f = finding();
    applyIssueDrift(ctx, f, issue(body), drift!);
    expect(f.risks?.[0]).toMatch(/was in tenacity\/before.py when it was filed and is gone at HEAD/);
    expect(f.signals.confidence).toBe(0.36);
    expect(f.evidence.map((e) => e.kind)).toEqual(["file"]);
  });

  it("finds the file through a traceback and reports it when the frame's line is gone", async () => {
    const body = 'Traceback (most recent call last):\n  File "/venv/lib/python3.12/site-packages/tenacity/before.py", line 6, in log_it\n    fn_name = retry_state.fn.__name__\nAttributeError: NoneType\n';
    const drift = await assessIssueDrift(ctx, issue(body), []);
    expect(drift?.files).toEqual(["tenacity/before.py"]);
    // the frame's line was edited in place (its first two thirds survive), so it counts as present, not gone
    expect(drift?.gone).toEqual([]);
    expect(drift?.present).toBe(1);
  });

  it("treats a permalinked line that is gone at HEAD as changed, even when the issue quotes only its own repro", async () => {
    const first = (await fixture.git(["rev-list", "--max-parents=0", "HEAD"])).trim();
    const body = `Repro:\n\`\`\`python\nfrom tenacity import before_log\nlogger = logging.getLogger(__name__)\n\`\`\`\nfn is not set [here](https://github.com/o/r/blob/${first}/tenacity/before.py#L3).`;
    const drift = await assessIssueDrift(ctx, issue(body), []);
    expect(drift?.files).toEqual(["tenacity/before.py"]);
    expect(drift?.gone).toEqual([{ line: "if retry_state.fn is None:", file: "tenacity/before.py" }]);
  });

  it("counts a line that only grew a call or argument as edited in place, not gone", async () => {
    await fixture.commit({ files: { "tenacity/before.py": AFTER.replace("logger.log(log_level, fn_name)", "logger.log(log_level, fn_name.strip())") }, message: "tidy", date: "2026-04-01T00:00:00Z" });
    const body = "```python\n        logger.log(log_level, fn_name)\n```";
    const drift = await assessIssueDrift(ctx, issue(body), ["tenacity/before.py"]);
    expect(drift?.present).toBe(1);
    expect(drift?.gone).toEqual([]);
  });

  it("stays quiet when the quoted code is still there", async () => {
    const body = "```python\n        logger.log(log_level, fn_name)\n```";
    const drift = await assessIssueDrift(ctx, issue(body, "2026-05-01T00:00:00Z"), []);
    expect(drift?.present).toBe(1);
    expect(drift?.gone).toEqual([]);
    expect(drift?.commits).toEqual([]);
    const f = finding();
    applyIssueDrift(ctx, f, issue(body), drift!);
    expect(f.risks).toEqual([]);
    expect(f.signals.confidence).toBe(0.6);
  });

  it("reports a later commit that names the issue", async () => {
    await fixture.commit({ files: { "README.md": "# t\n\nfixed\n" }, message: "docs: note the fix for #511", date: "2026-03-01T00:00:00Z" });
    const drift = await assessIssueDrift(ctx, issue("See README.md, it is wrong."), ["README.md"]);
    expect(drift?.referencing.map((c) => c.subject)).toEqual(["docs: note the fix for #511"]);
    const f = finding();
    applyIssueDrift(ctx, f, issue(""), drift!);
    expect(f.risks?.[0]).toMatch(/mentions #511; the issue may already be addressed/);
    expect(f.signals.confidence).toBe(0.3);
  });

  it("returns nothing to say when the issue names no files and quotes no code", async () => {
    expect(await assessIssueDrift(ctx, issue("It is broken."), [])).toBeUndefined();
  });
});

describe("permalinks", () => {
  it("reads blob links into the same repository with their revision and line range", () => {
    const body = "set [here](https://github.com/jd/tenacity/blob/0d40e76f7d06d631fb127e1ec58c8bd776e70d49/tenacity/before.py#L38). Also https://github.com/jd/tenacity/blob/main/tenacity/__init__.py#L10-L12 and https://github.com/other/repo/blob/main/x.py#L1";
    expect(permalinks(body, { host: "github.com", owner: "jd", name: "tenacity" })).toEqual([
      { path: "tenacity/before.py", rev: "0d40e76f7d06d631fb127e1ec58c8bd776e70d49", lines: [38, 38] },
      { path: "tenacity/__init__.py", rev: "main", lines: [10, 12] },
    ]);
  });
});

describe("edited in place versus gone", () => {
  it("keeps a line whose first two thirds survive as present", async () => {
    const f = await FixtureRepo.create();
    try {
      await f.commit({ files: { "pydantic/main.py": "def validate_json(cls, json_data):\n    return cls.__pydantic_validator__.validate_json(json_data, strict=strict, context=context)\n" }, date: "2024-01-01T00:00:00Z" });
      await f.commit({ files: { "pydantic/main.py": "def validate_json(cls, json_data):\n    return cls.__pydantic_validator__.validate_json(json_data, strict=strict, context=context, by_alias=by_alias)\n" }, date: "2025-02-26T00:00:00Z", message: "Improve alias configuration APIs" });
      const repo = openRepo(f.dir);
      const files = (await repo.lsFiles()).map((path) => ({ path, vendored: false }));
      const c = { repo, ref: { host: "github.com", owner: "o", name: "r" }, inventory: { files, byPath: new Map(files.map((x) => [x.path, x])) }, nowIso: "2026-10-22T00:00:00Z" } as unknown as AnalysisContext;
      const body = "```python\n    return cls.__pydantic_validator__.validate_json(json_data, strict=strict, context=context)\n```";
      const drift = await assessIssueDrift(c, issue(body, "2024-04-10T00:00:00Z"), ["pydantic/main.py"]);
      expect(drift?.gone).toEqual([]);
      expect(drift?.present).toBe(1);
      const fnd = finding();
      applyIssueDrift(c, fnd, issue(body, "2024-04-10T00:00:00Z"), drift!);
      expect(fnd.risks).toEqual([]); // one commit on the file is ordinary maintenance
    } finally {
      await f.cleanup();
    }
  });
});
