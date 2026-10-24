/**
 * Keys pressed while gitgoblin works do not vanish: a second `y` typed at one question waits in the
 * input buffer, through minutes of agent work, and answers the next question before the person has
 * read it. `discardTypeAhead` empties that buffer just before a question is asked.
 */

/** The parts of a terminal's stdin this needs; `process.stdin` has them all. */
export interface TypeAheadInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface Discarded {
  /** Bytes thrown away. */
  discarded: number;
  /** Ctrl-C was among them: raw mode turns it into a byte, so the caller must act on it. */
  interrupted: boolean;
}

/**
 * Reads and drops whatever is waiting on a terminal's input for `waitMs`. Raw mode makes an
 * unfinished line readable too; the previous mode is put back afterwards. Input that is not a
 * terminal is left alone, since gitgoblin never asks a question there.
 */
export async function discardTypeAhead(input: TypeAheadInput, waitMs = 100): Promise<Discarded> {
  if (!input.isTTY || typeof input.setRawMode !== "function") return { discarded: 0, interrupted: false };
  const wasRaw = Boolean(input.isRaw);
  let discarded = 0;
  let interrupted = false;
  const drop = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    discarded += bytes.length;
    if (bytes.includes(3)) interrupted = true;
  };
  input.setRawMode(true);
  input.on("data", drop);
  input.resume();
  try {
    await new Promise((done) => setTimeout(done, waitMs));
  } finally {
    input.off("data", drop);
    input.pause();
    input.setRawMode(wasRaw);
  }
  return { discarded, interrupted };
}
