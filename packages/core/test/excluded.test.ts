import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXCLUDED_PROJECTS, excludedEntry, parseExcludedProjects } from "../src/index.ts";

const LIST = `# Excluded projects

Entries are one per line as \`host/owner/name\`, for example \`github.com/example/widgets\`.

## List

- github.com/Example/Widgets
\`codeberg.org/someone\`
gitlab.com/group/project
- not an entry
- github.com/a/b/c
- https://github.com/x/y

## After the list

github.com/later/ignored
`;

describe("parseExcludedProjects", () => {
  it("reads entries under the List heading only, lowercased, with or without bullets and backticks", () => {
    expect(parseExcludedProjects(LIST)).toEqual(["github.com/example/widgets", "codeberg.org/someone", "gitlab.com/group/project"]);
  });

  it("finds nothing in a list that only says it is empty", () => {
    expect(parseExcludedProjects("## List\n\nNo projects have asked to be excluded yet.\n")).toEqual([]);
  });

  it("matches the list shipped in the package to docs/excluded-projects.md", () => {
    const doc = readFileSync(new URL("../../../docs/excluded-projects.md", import.meta.url), "utf8");
    expect(parseExcludedProjects(doc)).toEqual([...EXCLUDED_PROJECTS]);
  });
});

describe("excludedEntry", () => {
  const entries = ["github.com/example/widgets", "codeberg.org/someone"];

  it("matches a listed repository and every repository of a listed owner, ignoring case", () => {
    expect(excludedEntry({ host: "github.com", owner: "EXAMPLE", name: "widgets" }, entries)).toBe("github.com/example/widgets");
    expect(excludedEntry({ host: "codeberg.org", owner: "Someone", name: "anything" }, entries)).toBe("codeberg.org/someone");
  });

  it("leaves other repositories, owners and hosts alone", () => {
    expect(excludedEntry({ host: "github.com", owner: "example", name: "gadgets" }, entries)).toBeUndefined();
    expect(excludedEntry({ host: "github.com", owner: "someone", name: "anything" }, entries)).toBeUndefined();
    expect(excludedEntry({ host: "github.com", owner: "example-widgets", name: "x" }, entries)).toBeUndefined();
  });

  it("uses the shipped list by default", () => {
    expect(excludedEntry({ host: "github.com", owner: "anandkaranubc", name: "gitgoblin" })).toBeUndefined();
  });
});
