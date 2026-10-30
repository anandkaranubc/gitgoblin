import { describe, expect, it } from "vitest";
import { cliFlagsInCode, installCommands } from "../src/analyzers/docs-drift.ts";

describe("README install commands", () => {
  it("does not take requirement, constraint or editable arguments for the package name", () => {
    expect(installCommands("pip install -r requirements.txt\npip install -c constraints.txt\npip install -e git+https://example.invalid/x/y\nuv pip install --requirement=dev.txt")).toEqual([]);
    expect(installCommands("pip install requirements-dev.txt")).toEqual([]);
    expect(installCommands("pip install -U weatherapp").map((i) => i.name)).toEqual(["weatherapp"]);
  });
});

describe("negatable flags", () => {
  it("records both halves of a Click --x/--no-x option, and argparse's BooleanOptionalAction", () => {
    const click = '@click.option("--color/--no-color", default=True)\n@click.option("-v", "--shout / --no-shout")\n';
    expect([...cliFlagsInCode(click)].sort()).toEqual(["color", "no-color", "no-shout", "shout"]);
    const argparse = 'parser.add_argument("--color", action=argparse.BooleanOptionalAction, help="colour output")\nparser.add_argument("--verbose", action="store_true")\n';
    expect([...cliFlagsInCode(argparse)].sort()).toEqual(["color", "no-color", "verbose"]);
  });
});
