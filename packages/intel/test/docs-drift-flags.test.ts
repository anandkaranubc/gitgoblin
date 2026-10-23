import { describe, expect, it } from "vitest";
import { cliFlagsInCode } from "../src/analyzers/docs-drift.ts";

describe("cliFlagsInCode", () => {
  it("finds click options assigned to a name with the flag on a later line, and argparse aliases", () => {
    const src = 'upgrade_package = click.option(\n    "-P",\n    "--upgrade-package",\n    "upgrade_packages",\n)\nparser.add_argument("-v", "-V", "--verbose-level")\n@click.option("--dry-run", is_flag=True)\n';
    expect([...cliFlagsInCode(src)].sort()).toEqual(["dry-run", "upgrade-package", "verbose-level"]);
  });
});
