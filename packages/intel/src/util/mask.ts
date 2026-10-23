/**
 * Blank out string literals, comments and (in JavaScript) regex literals,
 * keeping every character position and line break. Pattern matchers then see
 * only code: a deprecated API quoted in a rule table, a changelog string or a
 * comment is not a call site.
 *
 * Both kinds of literal are always traversed, so a `//` inside a string never
 * starts a comment, but each is blanked only when its option is on. Languages
 * whose syntax is unknown ("other") are returned unchanged rather than guessed at.
 */
export type MaskLang = "js" | "py" | "go" | "rs" | "rb" | "c" | "sh" | "other";

export interface MaskOptions {
  /** Blank string, template and regex literals (default true). */
  strings?: boolean;
  /** Blank line and block comments (default true). */
  comments?: boolean;
}

export function maskLangFor(path: string): MaskLang {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "js";
  if (/\.pyi?$/.test(path)) return "py";
  if (/\.go$/.test(path)) return "go";
  if (/\.rs$/.test(path)) return "rs";
  if (/\.rb$/.test(path)) return "rb";
  if (/\.(java|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|kt|kts|swift|php|dart|scala|m|mm|groovy)$/.test(path)) return "c";
  if (/\.(sh|bash|zsh|yml|yaml|toml|pl|pm|r|ex|exs|nim|ps1)$/i.test(path)) return "sh";
  return "other";
}

const SLASH_COMMENTS = new Set<MaskLang>(["js", "go", "rs", "c"]);
const HASH_COMMENTS = new Set<MaskLang>(["py", "rb", "sh"]);
/** What may precede a `/` that opens a regex literal rather than a division. */
const REGEX_PRECEDER = /[=(,:;!&|?{}[>][ \t]{0,40}$|\b(return|typeof|case|in|of|do|else)[ \t]{0,40}$/;
/** Characters looked back from a `/`; reading from the line start each time would be quadratic on long lines. */
const LOOKBACK = 64;

export function maskCodeLiterals(text: string, lang: MaskLang, options: MaskOptions = {}): string {
  if (lang === "other") return text;
  const maskStrings = options.strings ?? true;
  const maskComments = options.comments ?? true;
  const out = text.split("");
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? n : end;
  };

  /** Quoted string with backslash escapes, ending at the quote or the line end. Returns the index after it. */
  const scanQuoted = (i: number, quote: string): number => {
    let j = i + 1;
    while (j < n) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === quote || text[j] === "\n") break; // unterminated: stop at the line end
      j++;
    }
    if (maskStrings) blank(i + 1, j);
    return text[j] === quote ? j + 1 : j;
  };

  /** Raw string without escapes (Go backticks, Rust r"..."), possibly multi-line. */
  const scanRaw = (i: number, start: number, close: string): number => {
    const end = text.indexOf(close, start);
    if (maskStrings) blank(start, end === -1 ? n : end);
    return end === -1 ? n : end + close.length;
  };

  /** JavaScript template literal: text segments are blanked, `${...}` expressions are scanned as code. */
  const scanTemplate = (i: number): number => {
    let j = i + 1;
    let segment = j;
    while (j < n) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === "`") {
        if (maskStrings) blank(segment, j);
        return j + 1;
      }
      if (text[j] === "$" && text[j + 1] === "{") {
        if (maskStrings) blank(segment, j);
        j = scanCode(j + 2, true);
        segment = j;
        continue;
      }
      j++;
    }
    if (maskStrings) blank(segment, n);
    return n;
  };

  /** Code from `i`; with `untilBrace`, stops after the `}` that closes the current template expression. */
  const scanCode = (i: number, untilBrace: boolean): number => {
    let depth = 0;
    let lineStart = text.lastIndexOf("\n", i - 1) + 1;
    while (i < n) {
      const c = text[i]!;
      if (c === "\n") {
        lineStart = i + 1;
        i++;
        continue;
      }
      const lineComment = (SLASH_COMMENTS.has(lang) && c === "/" && text[i + 1] === "/") || (HASH_COMMENTS.has(lang) && c === "#");
      if (lineComment) {
        const stop = lineEnd(i);
        if (maskComments) blank(i, stop);
        i = stop;
        continue;
      }
      if (SLASH_COMMENTS.has(lang) && c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        if (maskComments) blank(i, stop);
        i = stop;
        continue;
      }
      if (lang === "py" && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const quote = text.slice(i, i + 3);
        let j = i + 3;
        while (j < n && !text.startsWith(quote, j)) j += text[j] === "\\" ? 2 : 1;
        if (maskStrings) blank(i + 3, Math.min(j, n));
        i = Math.min(j + 3, n);
        continue;
      }
      if (lang === "rs" && c === "r") {
        const raw = /^r(#*)"/.exec(text.slice(i, i + 8));
        if (raw) {
          i = scanRaw(i, i + raw[0].length, `"${raw[1]}`);
          continue;
        }
      }
      if (lang === "rs" && c === "'" && !/^'(\\.|[^'\\])'/.test(text.slice(i, i + 4))) {
        i++; // a lifetime such as 'a, not a char literal
        continue;
      }
      if (c === "`" && lang === "js") {
        i = scanTemplate(i);
        continue;
      }
      if (c === "`" && lang === "go") {
        i = scanRaw(i, i + 1, "`");
        continue;
      }
      if (c === '"' || c === "'") {
        i = scanQuoted(i, c);
        continue;
      }
      const from = Math.max(lineStart, i - LOOKBACK);
      const before = text.slice(from, i);
      if (lang === "js" && c === "/" && ((from === lineStart && before.trim() === "") || REGEX_PRECEDER.test(before))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== "\n") {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) break;
          j++;
        }
        if (j < n && text[j] === "/") {
          if (maskStrings) blank(i + 1, j);
          i = j + 1;
          continue;
        }
      }
      if (untilBrace) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i + 1;
          depth--;
        }
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return out.join("");
}
