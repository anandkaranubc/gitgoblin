import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTask } from "../src/intake.ts";

describe("examples/task.example.json", () => {
  it("is a valid Task", () => {
    const task = parseTask(JSON.parse(readFileSync(new URL("../examples/task.example.json", import.meta.url), "utf8")));
    expect(task.repo.localPath).toBeDefined();
    expect(task.commands.test).toBe("npm test");
  });
});
