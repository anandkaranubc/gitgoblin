/**
 * Issue text for the people and agents downstream. Issue templates wrap the report in
 * boilerplate ("Have you read the troubleshooting section? Yes", checklists, empty
 * "_No response_" answers); a summary should start at the problem, and an agent working
 * offline needs the body itself, reproduction snippets included.
 *
 * Issue bodies are written by anyone, up to 65,536 characters, so everything here is a single
 * pass over lines with string methods: no regular expression that can backtrack across a line.
 */

export const MAX_ISSUE_BODY = 20_000;

/** Template sections that carry no information about the problem. Matched against short heading text only. */
const BOILERPLATE_HEADING = /\b(have you (read|searched|checked)|did you (read|search)|before (you )?(submit|open|post)|prerequisites?|pre-?flight|checklist|code of conduct|contributing guidelines?|terms|validations?|confirm(ation)?s?|i have|is there an existing issue|existing issues?|search(ed)? (for )?existing)\b/i;
/** Sections that describe the problem, in the order a reader wants them. */
const PROBLEM_HEADING = /\b(describe the (bug|issue|problem)|bug description|what happened|what problem|problem|description|summary|current behaviou?r|actual behaviou?r|observed behaviou?r|issue|details?|motivation|feature request|proposal|steps to reproduce|reproduction)\b/i;
const EMPTY_ANSWER = /^(_?no response_?|n\/?a|none|-|yes|no|y|n)$/i;
const ENVIRONMENT_HEADING = /\b(version|environment|operating system|platform|os|browser|node|python|runtime)\b/i;
const GREETING = /^(?:hi|hello|hey|greetings|good (?:morning|afternoon|evening))\b(?:\s+(?:all|there|team|folks|everyone|everybody|guys|maintainers|@?[\w-]{1,39}))?\s{0,3}[,!.:]{0,3}\s{0,3}/i;

interface Section {
  heading: string;
  lines: string[];
}

/** An ATX heading's text (`### Steps to reproduce ##` gives "Steps to reproduce"), or undefined. CommonMark rules, without regex backtracking. */
export function atxHeading(line: string): string | undefined {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let level = 0;
  while (line[i + level] === "#") level++;
  if (level === 0 || level > 6) return undefined;
  const after = line[i + level];
  if (after !== undefined && after !== " " && after !== "\t") return undefined;
  let text = line.slice(i + level).trim();
  // A closing run of #s counts only when a space precedes it ("Using F#" keeps its #).
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return text;
}

/** The fence a line opens or closes (``` or ~~~, three or more), or undefined. */
function fenceOf(line: string): string | undefined {
  const t = line.trimStart();
  if (line.length - t.length > 3) return undefined;
  const ch = t[0];
  if (ch !== "`" && ch !== "~") return undefined;
  let n = 0;
  while (t[n] === ch) n++;
  return n >= 3 ? ch.repeat(n) : undefined;
}

/** Lines with HTML comments removed outside code fences, and headings recognised only outside them. */
function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section = { heading: "", lines: [] };
  let fence: string | undefined;
  let inComment = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      current.lines.push(raw);
      const f = fenceOf(raw);
      if (f && f[0] === fence[0] && f.length >= fence.length && raw.trim() === f) fence = undefined;
      continue;
    }
    // Template instructions live in HTML comments, sometimes across several lines and headings.
    let line = "";
    let rest = raw;
    while (rest.length) {
      if (inComment) {
        const close = rest.indexOf("-->");
        if (close === -1) { rest = ""; break; }
        rest = rest.slice(close + 3);
        inComment = false;
      } else {
        const open = rest.indexOf("<!--");
        if (open === -1) { line += rest; rest = ""; break; }
        line += rest.slice(0, open);
        rest = rest.slice(open + 4);
        inComment = true;
      }
    }
    if (inComment && line.trim() === "") continue;
    const opened = fenceOf(line);
    if (opened) {
      fence = opened;
      current.lines.push(line);
      continue;
    }
    const heading = atxHeading(line);
    if (heading !== undefined) {
      out.push(current);
      current = { heading, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out.filter((s) => s.heading || s.lines.some((l) => l.trim()));
}

/** Checklist items removed (outside code), blank runs collapsed. */
function clean(lines: string[]): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const f = fenceOf(line);
    if (fence) {
      kept.push(line);
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = undefined;
      continue;
    }
    if (f) fence = f;
    const t = line.trimStart();
    if (!fence && (t.startsWith("- [ ] ") || t.startsWith("- [x] ") || t.startsWith("- [X] ") || t.startsWith("* [ ] ") || t.startsWith("* [x] "))) continue;
    if (line.trim() === "" && kept.length && kept[kept.length - 1]!.trim() === "") continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function informative(s: Section): boolean {
  const text = clean(s.lines);
  if (!text || EMPTY_ANSWER.test(text)) return false;
  // A template question ("Have you read the docs?", "Checklist") is boilerplate when its answer is short;
  // a real section that merely shares a word ("## Validation errors are not shown") has substance.
  if (s.heading.length <= 120 && BOILERPLATE_HEADING.test(s.heading) && !text.includes("```")) {
    const limit = s.heading.trimEnd().endsWith("?") ? 300 : 80;
    if (text.length <= limit) return false;
  }
  return true;
}

/** Cut at a character boundary, close a code fence left open, and say that text was cut. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 60);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // half of a surrogate pair
  let open: string | undefined;
  for (const line of cut.split("\n")) {
    const f = fenceOf(line);
    if (!f) continue;
    if (!open) open = f;
    else if (f[0] === open[0] && f.length >= open.length && line.trim() === f) open = undefined;
  }
  return `${cut.trimEnd()}${open ? `\n${open}` : ""}\n\n[issue text truncated]`;
}

/** The issue body for an agent: boilerplate sections dropped, everything else verbatim, capped. */
export function issueBody(markdown: string): string {
  const kept = sections(markdown).filter(informative);
  const text = kept.map((s) => (s.heading ? `### ${s.heading}\n\n${clean(s.lines)}` : clean(s.lines))).join("\n\n").trim();
  return cap(text, MAX_ISSUE_BODY);
}

/** Markdown that starts at the problem statement: the first problem-describing section if the template has one. */
export function problemStatement(markdown: string): string {
  const kept = sections(markdown).filter(informative);
  const problem = kept.find((s) => s.heading.length <= 120 && PROBLEM_HEADING.test(s.heading));
  const ordered = problem ? [problem, ...kept.filter((s) => s !== problem)] : kept;
  // Short answers to version and environment questions say nothing a summary needs.
  const prose = ordered.filter((s) => s === problem || !(s.heading.length <= 120 && ENVIRONMENT_HEADING.test(s.heading)));
  // "Hello," or "Hi team!" opens many reports and says nothing about the problem.
  return prose.map((s) => clean(s.lines)).join("\n\n").trim().replace(GREETING, "");
}

/** A question that hands the decision to maintainers: which approach, would you accept, should we. Bounded spans. */
const ASKS_TO_CHOOSE = /\b(?:which (?:direction|approach|option|one|way|design|solution|variant)s?\b[^.?\n]{0,60}\b(?:prefer|like|want|choose|recommend|go with)|do you prefer\b|would you (?:prefer|accept|be open|rather)\b|should (?:we|i)\b[^.?\n]{0,80}\?|what(?:'s| is| would be) (?:the )?(?:preferred|best|right|recommended) (?:way|approach|direction|option)|(?:any|your) preferences?\b|(?:are you|is the project) open to\b|how would you like (?:this|me|us|it)\b)/i;
/** "Possible directions:" followed by a numbered or bulleted list. */
const OPTION_LIST = /\b(?:directions|options|approaches|alternatives|solutions|choices)\b[^\n]{0,40}\n[ \t]{0,6}(?:1[.)]|[-*])[ \t]/i;

/**
 * Does the issue end by asking maintainers to pick an approach? Such an issue needs a decision before code:
 * an outsider (or an agent) who implements one option risks having the work rejected. Looks at the last part of
 * the template-free body, where reporters put the question.
 */
export function asksMaintainersToChoose(markdown: string): string | undefined {
  const body = issueBody(markdown);
  const tail = body.slice(-1500);
  const question = ASKS_TO_CHOOSE.exec(tail);
  if (question) return `the issue asks the maintainers to decide ("${question[0].trim().slice(0, 60)}")`;
  if (OPTION_LIST.test(body) && tail.includes("?")) return "the issue lists options and asks which to take";
  return undefined;
}
