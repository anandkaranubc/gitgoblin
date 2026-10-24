import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { discardTypeAhead } from "../src/prompt.ts";

/** A stand-in for a terminal's stdin: a stream with raw mode that records each switch. */
function terminal(isTTY = true) {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void; modes: boolean[] };
  stream.isTTY = isTTY;
  stream.isRaw = false;
  stream.modes = [];
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    stream.modes.push(mode);
  };
  stream.pause();
  return stream;
}

describe("discardTypeAhead", () => {
  it("throws away keys typed before the question, so an early y cannot answer it", async () => {
    const input = terminal();
    input.write("y\n");
    const result = await discardTypeAhead(input, 20);
    expect(result).toEqual({ discarded: 2, interrupted: false });
    input.write("publish\n");
    input.resume();
    const [chunk] = await new Promise<Buffer[]>((done) => input.once("data", (data: Buffer) => done([data])));
    expect(chunk.toString()).toBe("publish\n");
  });

  it("reads in raw mode, so an unfinished line is discarded too, and puts the mode back", async () => {
    const input = terminal();
    await discardTypeAhead(input, 5);
    expect(input.modes).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
  });

  it("reports Ctrl-C typed while it waits, so the caller can stop instead of swallowing it", async () => {
    const input = terminal();
    input.write("\u0003");
    expect(await discardTypeAhead(input, 20)).toEqual({ discarded: 1, interrupted: true });
  });

  it("leaves input that is not a terminal alone", async () => {
    const input = terminal(false);
    input.write("y\n");
    expect(await discardTypeAhead(input, 5)).toEqual({ discarded: 0, interrupted: false });
    expect(input.modes).toEqual([]);
    expect(input.read()?.toString()).toBe("y\n");
  });
});
