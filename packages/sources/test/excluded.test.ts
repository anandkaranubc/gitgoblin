import { EXCLUDED_PROJECTS_URL } from "@gitgoblin/core";
import { describe, expect, it } from "vitest";
import { HttpClient, loadExcludedProjects, MemoryCache } from "../src/index.ts";
import { fetchStub } from "./helpers.ts";

const LIST = "# Excluded projects\n\n## List\n\n- github.com/example/widgets\n- codeberg.org/someone\n";

describe("loadExcludedProjects", () => {
  it("reads the current list from gitgoblin's repository and reuses it from the cache", async () => {
    const { fetch, calls } = fetchStub(() => new Response(LIST, { status: 200, headers: { "content-type": "text/plain" } }));
    const http = new HttpClient({ cache: new MemoryCache(), fetch });
    expect(await loadExcludedProjects(http)).toEqual(["github.com/example/widgets", "codeberg.org/someone"]);
    expect(await loadExcludedProjects(http)).toEqual(["github.com/example/widgets", "codeberg.org/someone"]);
    expect(calls.map((call) => call.url)).toEqual([EXCLUDED_PROJECTS_URL]);
  });

  it("falls back to the shipped list, without retrying, when the current one cannot be read", async () => {
    const { fetch, calls } = fetchStub(() => new Response("unavailable", { status: 503 }));
    expect(await loadExcludedProjects(new HttpClient({ cache: new MemoryCache(), fetch }))).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
