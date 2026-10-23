import { describe, expect, it } from "vitest";
import { resolveGitHubToken } from "../src/index.ts";

describe("resolveGitHubToken", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN, then gh", async () => {
    const gh = async () => "from-gh\n";
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, gh)).toBe("a");
    expect(await resolveGitHubToken({ GH_TOKEN: "b" }, gh)).toBe("b");
    expect(await resolveGitHubToken({}, gh)).toBe("from-gh");
  });

  it("returns undefined when gh is missing or logged out", async () => {
    expect(
      await resolveGitHubToken({}, async () => {
        throw new Error("not found");
      }),
    ).toBeUndefined();
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "  " }, async () => "")).toBeUndefined();
  });
});
