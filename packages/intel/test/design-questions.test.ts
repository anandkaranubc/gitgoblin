import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asksMaintainersToChoose } from "../src/analyzers/issue-text.ts";

// jd/tenacity#763: three possible directions, then "Which direction do you prefer?", no maintainer reply.
const tenacity763 = readFileSync(join(import.meta.dirname, "fixtures", "issue-763-design-question.md"), "utf8");

describe("issues that ask maintainers to choose", () => {
  it("recognises a request for a maintainer decision", () => {
    expect(asksMaintainersToChoose(tenacity763)).toMatch(/Which direction do you prefer/);
    expect(asksMaintainersToChoose("We could cache the parser or rebuild it per call.\n\nWould you accept a PR that caches it?")).toMatch(/Would you accept/);
    expect(asksMaintainersToChoose("Possible options:\n1. add a flag\n2. change the default\n\nWhat do we do here?")).toBe("the issue lists options and asks which to take");
  });

  it("leaves ordinary bug reports alone, including ones that end with a question", () => {
    expect(asksMaintainersToChoose("Calling `retry()` twice raises KeyError.\n\n```py\nretry(); retry()\n```\n\nIs this expected?")).toBeUndefined();
    expect(asksMaintainersToChoose("The parser drops trailing commas. Any thoughts? Do you think this is a bug?")).toBeUndefined();
    expect(asksMaintainersToChoose("Steps:\n1. install\n2. run\n\nIt crashes with a stack trace.")).toBeUndefined();
  });
});
