/**
 * Issue text for the people and agents downstream. Issue templates wrap the report in
 * boilerplate ("Have you read the troubleshooting section? Yes", checklists, empty
 * "_No response_" answers); a summary should start at the problem, and an agent working
 * offline needs the body itself, reproduction snippets included.
 */

export const MAX_ISSUE_BODY = 20_000;

/** Template sections that carry no information about the problem. */
const BOILERPLATE_HEADING = /\b(have you (read|searched|checked)|did you (read|search)|before (you )?(submit|open|post)|prerequisites?|pre-?flight|checklist|code of conduct|contributing guidelines?|terms|validations?|confirm(ation)?s?|i have|is there an existing issue|existing issues?|search(ed)? (for )?existing)\b/i;
/** Sections that describe the problem, in the order a reader wants them. */
const PROBLEM_HEADING = /\b(describe the (bug|issue|problem)|bug description|what happened|what problem|problem|description|summary|current behaviou?r|actual behaviou?r|observed behaviou?r|issue|details?|motivation|feature request|proposal|steps to reproduce|reproduction)\b/i;
const GREETING = /^(?:hi|hello|hey|greetings|good (?:morning|afternoon|evening))\b(?:\s+(?:all|there|team|folks|everyone|everybody|guys|maintainers|@?[\w-]+))?\s*[,!.:]*\s*/i;
const EMPTY_ANSWER = /^\s*(_?no response_?|n\/?a|none|-|yes|no|y|n|\[x\].*|\[ \].*)\s*$/i;

interface Section {
  heading: string;
  text: string;
}

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section = { heading: "", text: "" };
  for (const line of markdown.split("\n")) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(current);
      current = { heading: h[1]!, text: "" };
    } else {
      current.text += `${line}\n`;
    }
  }
  out.push(current);
  return out.filter((s) => s.heading || s.text.trim());
}

/** Comments, checklist items and empty or yes/no template answers removed; code kept. */
function clean(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*[-*]\s+\[[ xX]\]\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function informative(s: Section): boolean {
  if (BOILERPLATE_HEADING.test(s.heading)) return false;
  const text = clean(s.text);
  return text.length > 0 && !EMPTY_ANSWER.test(text);
}

/** The issue body for an agent: boilerplate sections dropped, everything else verbatim, capped. */
export function issueBody(markdown: string): string {
  const kept = sections(markdown.replace(/\r\n/g, "\n")).filter(informative);
  const text = kept.map((s) => (s.heading ? `### ${s.heading}\n\n${clean(s.text)}` : clean(s.text))).join("\n\n").trim();
  return text.length <= MAX_ISSUE_BODY ? text : `${text.slice(0, MAX_ISSUE_BODY - 40).trimEnd()}\n\n[issue text truncated]`;
}

/** Markdown that starts at the problem statement: the first problem-describing section if the template has one. */
export function problemStatement(markdown: string): string {
  const kept = sections(markdown.replace(/\r\n/g, "\n")).filter(informative);
  const problem = kept.find((s) => PROBLEM_HEADING.test(s.heading));
  const ordered = problem ? [problem, ...kept.filter((s) => s !== problem)] : kept;
  // Short answers to version and environment questions say nothing a summary needs.
  const prose = ordered.filter((s) => s === problem || !/\b(version|environment|operating system|platform|os|browser|node|python|runtime)\b/i.test(s.heading));
  // "Hello," or "Hi team!" opens many reports and says nothing about the problem.
  return prose.map((s) => clean(s.text)).join("\n\n").trim().replace(GREETING, "");
}
