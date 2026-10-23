import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { looksLikeSha, openRepo, parseLog } from "../src/git/repo.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";

describe("LocalGitRepo", () => {
  let fixture: FixtureRepo;

  beforeAll(async () => {
    fixture = await FixtureRepo.create();
    await fixture.commit({
      files: { "src/a.py": "x = 1\n", "README.md": "# hi\n" },
      message: "feat: initial",
      date: "2024-01-01T00:00:00Z",
      author: { name: "Ann", email: "ann@example.com" },
    });
    await fixture.commit({
      files: { "src/a.py": "x = 1\n# TODO: remove\n" },
      message: "fix: todo",
      date: "2025-06-01T00:00:00Z",
      author: { name: "Bob", email: "bob@example.com" },
    });
  });

  afterAll(() => fixture.cleanup());

  it("lists files and reads text", async () => {
    const repo = openRepo(fixture.dir);
    expect(await repo.lsFiles()).toEqual(["README.md", "src/a.py"]);
    expect(await repo.readText("README.md")).toBe("# hi\n");
    expect(await repo.readText("missing.md")).toBeUndefined();
  });

  it("parses the log with file names, newest first", async () => {
    const repo = openRepo(fixture.dir);
    const commits = await repo.log();
    expect(commits.map((c) => c.subject)).toEqual(["fix: todo", "feat: initial"]);
    expect(commits[0]?.files).toEqual(["src/a.py"]);
    expect(commits[1]?.files).toEqual(["README.md", "src/a.py"]);
    expect(commits[0]?.authorEmail).toBe("bob@example.com");
    expect(commits[0]?.date.startsWith("2025-06-01")).toBe(true);
  });

  it("filters the log by --since", async () => {
    const repo = openRepo(fixture.dir);
    const commits = await repo.log({ since: "2025-01-01" });
    expect(commits).toHaveLength(1);
  });

  it("blames a single line", async () => {
    const repo = openRepo(fixture.dir);
    const blame = await repo.blameLine("src/a.py", 2);
    expect(blame?.authorEmail).toBe("bob@example.com");
    expect(blame?.date.startsWith("2025-06-01")).toBe(true);
    expect(await repo.blameLine("src/a.py", 99)).toBeUndefined();
  });

  it("reports default branch, first commit date and tags", async () => {
    const repo = openRepo(fixture.dir);
    expect(await repo.defaultBranch()).toBe("main");
    expect((await repo.firstCommitDate())?.startsWith("2024-01-01")).toBe(true);
    await fixture.git(["tag", "v1.0.0"]);
    expect((await repo.tags()).map((t) => t.name)).toEqual(["v1.0.0"]);
  });

  it("greps tracked files for a whole word", async () => {
    const repo = openRepo(fixture.dir);
    expect(await repo.grep("TODO", ["src"])).toEqual(["src/a.py"]);
    expect(await repo.grep("nothing-here", ["src"])).toEqual([]);
  });

  it("tells commit ids from branch and tag names", () => {
    expect(looksLikeSha("63448dfa1b2c")).toBe(true);
    expect(looksLikeSha("main")).toBe(false);
    expect(looksLikeSha("v1.2.3")).toBe(false);
    expect(looksLikeSha("deadbeef")).toBe(true);
    expect(looksLikeSha(undefined)).toBe(false);
  });

  it("parseLog tolerates empty input", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("line endings", () => {
  it("reads CRLF files with LF line endings and the same line count", async () => {
    const crlf = await FixtureRepo.create();
    try {
      await crlf.commit({ files: { "win.md": "# Title\r\n\r\nSee [docs](docs/a.md).\r\n" }, message: "crlf" });
      expect(await openRepo(crlf.dir).readText("win.md")).toBe("# Title\n\nSee [docs](docs/a.md).\n");
    } finally {
      await crlf.cleanup();
    }
  });
});
