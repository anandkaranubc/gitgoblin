import { describe, expect, it } from "vitest";
import { pythonApiDocs, tsApiDocs } from "../src/analyzers/api-docs.ts";

describe("api docs coverage", () => {
  it("counts public Python defs and docstrings, skipping private names, overloads and stubs", () => {
    const src = `
def documented(a, b):
    """Add things."""
    return a + b

def undocumented(x):
    return x

def _private():
    return 1

class Thing:
    """A thing."""
    def method(self):
        return 2
    def described(self):
        '''Docs.'''
        return 3

@overload
def over(x: int) -> int: ...
def abstract(self):
    ...
`;
    const s = pythonApiDocs("pkg/mod.py", src);
    expect(s.publicCount).toBe(5);
    expect(s.documented).toBe(3);
    expect(s.undocumented).toEqual(["undocumented", "method"]);
  });

  it("counts exported TypeScript declarations and JSDoc", () => {
    const src = `
/** Parses input. */
export function parse(x: string) { return x; }
export const helper = () => 1;
/**
 * Multi-line.
 */
export class Thing {}
export type Opts = { a: number };
`;
    const s = tsApiDocs("src/index.ts", src);
    expect(s.publicCount).toBe(4);
    expect(s.documented).toBe(2);
    expect(s.undocumented).toEqual(["helper", "Opts"]);
  });
});
