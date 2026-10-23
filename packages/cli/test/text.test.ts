import { describe, expect, it } from "vitest";
import { plain } from "../src/text.ts";

describe("plain", () => {
  it("removes ANSI colour and cursor sequences that could restyle or rewrite the terminal", () => {
    expect(plain("\u001b[31mred\u001b[0m text")).toBe("red text");
    expect(plain("line\u001b[2K\u001b[1Gcleared")).toBe("linecleared");
    expect(plain("\u001b[?25lhidden cursor")).toBe("hidden cursor");
  });

  it("removes operating-system commands such as fake hyperlinks and title changes", () => {
    expect(plain("\u001b]8;;https://evil.example\u0007click here\u001b]8;;\u0007")).toBe("click here");
    expect(plain("\u001b]0;new title\u001b\\after")).toBe("after");
  });

  it("removes other control characters but keeps tabs and newlines", () => {
    expect(plain("a\u0000b\u0007c\rd\u007fe\u009bf")).toBe("abcdef");
    expect(plain("one\ttwo\nthree")).toBe("one\ttwo\nthree");
  });

  it("removes bidirectional and zero-width characters that can hide or reorder text", () => {
    expect(plain("safe‮​⁦﻿ text")).toBe("safe text");
  });

  it("leaves ordinary Unicode alone", () => {
    expect(plain("naïve café — 日本語 🙂 `code`")).toBe("naïve café — 日本語 🙂 `code`");
  });
});
