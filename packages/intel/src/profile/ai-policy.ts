import type { AiPolicy } from "../contracts.ts";
import { sentences, truncate } from "../util/text.ts";

/**
 * What a project says about AI-generated contributions, read from its contributing guide, README,
 * pull request template, code of conduct, agent instruction files and AI policy files. Calibrated
 * on real policies: Gentoo, NetBSD, Servo and QEMU decline AI-generated contributions; Ghostty and
 * nixpkgs ask for disclosure (nixpkgs in an `Assisted-by:` trailer); LLVM keeps "good first issue"
 * issues for people. Nothing found is "not_found", which is not permission.
 */

// "AI" only in capitals: the lowercase word is too common in other languages and identifiers.
const AI_ACRONYM = /\bA\.?I\b|\bLLMs?\b/;
const AI_WORDS = /\b(?:large language models?|gen(?:erative)?[- ]?AI|ChatGPT|Copilot|artificial intelligence|natural language processing|vibe[- ]cod\w*)\b/i;
// Mentions without a refusal or a disclosure rule count only when they are about using AI as a tool.
const AI_TOOL_USE = /\b(?:A\.?I|LLMs?)[- ](?:tools?|assist\w*|generated|written|agents?|coding|usage|use|content)\b|\b(?:using|use of|with) (?:an? )?(?:AI|LLMs?)\b/;
const CODE_WORD = /\b(?:contribut\w*|pull requests?|PRs?|patch(?:es)?|code|commits?|changes|submissions?|merge requests?)\b/i;
const FORBID = /\b(?:(?:is|are|be) not (?:accepted|allowed|permitted|welcome|merged|considered|tolerated)|(?:do|does|will|shall) not (?:accept|take|merge|allow|permit|want|consider)|(?:don't|doesn't|won't) (?:accept|take|merge|allow|permit|want|consider)|must not|may not|forbid(?:den|s)?|prohibit(?:ed|s)?|banned|disallow(?:ed|s)?|declin(?:e|ed|es)|refrain|reject(?:ed|s)?|no (?:AI|LLMs?))\b/i;
// "We do not forbid AI tools" and "We don't reject AI-assisted patches" allow them.
const NEGATED = /\b(?:not|n't|never) (?:\w+ ){0,2}?(?:forbid|prohibit|ban|disallow|reject|declin)/i;
// A condition makes it a rule for using AI, not a refusal of it; "without approval" still refuses.
const CONDITION = /\b(?:unless|until)\b|(?<!\beven )\bif\b|^when\b|\bwithout (?:\w+ ){0,2}?(?:review|understand|disclos|test|check|verif|label|mention|stat|attribut|edit)/i;
// Ghostty bans AI-generated art, images and audio while it takes AI-written code.
const MEDIA = /\b(?:media|art(?:work)?|images?|videos?|audio|illustrations?)\b/i;
const STARTER_ISSUES = /\bgood[- ]first[- ]issues?\b|\bbeginner[- ]friendly\b|\bfirst[- ]timers?\b/i;
const DISCLOSE = /\b(?:disclos\w*|reveal\w*|declare[ds]?|(?:must|should|please) (?:\w+ ){0,3}?(?:state|mention|indicate|note|label|mark|tag)\w*|assisted-by|generated-by)\b/i;
const POLICY = /\b(?:polic(?:y|ies)|must|should|allowed|permitted|accountab\w*|responsib\w*|review\w*|understand\w*|welcome)\b/i;
const TRAILER = /\b(Assisted-by|Generated-by):/i;
// Sentences are short; a longer run of text is not one, and the cap keeps every match cheap.
const MAX_SENTENCE = 1000;
const MAX_STATEMENTS = 5;

export interface PolicyText {
  path: string;
  text: string;
}

type Kind = "forbidden" | "starter" | "disclose" | "mentioned";

/** `aboutAi`: the sentence is in an AI policy file, where "tool-generated content" needs no AI word to mean AI. */
function classify(sentence: string, aboutAi: boolean): Kind | undefined {
  if (!aboutAi && !AI_ACRONYM.test(sentence) && !AI_WORDS.test(sentence)) return undefined;
  const refuses = FORBID.test(sentence) && !NEGATED.test(sentence);
  if (refuses && STARTER_ISSUES.test(sentence)) return "starter";
  if (refuses && CODE_WORD.test(sentence) && !CONDITION.test(sentence) && !MEDIA.test(sentence)) return "forbidden";
  if (DISCLOSE.test(sentence)) return "disclose";
  if ((aboutAi || AI_TOOL_USE.test(sentence)) && CODE_WORD.test(sentence) && POLICY.test(sentence)) return "mentioned";
  return undefined;
}

const ORDER: Kind[] = ["forbidden", "starter", "disclose", "mentioned"];

export function findAiPolicy(texts: readonly PolicyText[]): AiPolicy {
  const found = new Map<Kind, PolicyText[]>();
  // The README and CONTRIBUTING often say the same thing; quote it once.
  const seen = new Set<string>();
  let trailer: string | undefined;
  for (const { path, text } of texts) {
    const aboutAi = AI_POLICY_FILE.test(path);
    // curl lists Assisted-by: among trailers for people's help; only a paragraph about AI asks for it.
    for (const paragraph of trailer ? [] : text.split(/\n\s*\n/)) {
      if (aboutAi || AI_ACRONYM.test(paragraph) || AI_WORDS.test(paragraph)) trailer ??= TRAILER.exec(paragraph)?.[1];
    }
    for (const sentence of sentences(text)) {
      if (sentence.length > MAX_SENTENCE) continue;
      const kind = classify(sentence, aboutAi);
      const quoted = truncate(sentence, 300);
      if (!kind || seen.has(quoted)) continue;
      seen.add(quoted);
      const list = found.get(kind) ?? [];
      if (list.length < MAX_STATEMENTS) list.push({ path, text: quoted });
      found.set(kind, list);
    }
  }
  const stance = found.has("forbidden") ? "forbidden" : found.has("disclose") || trailer ? "disclose" : found.size > 0 ? "mentioned" : "not_found";
  const policy: AiPolicy = { stance, starterIssuesExcluded: found.has("starter"), statements: ORDER.flatMap((kind) => found.get(kind) ?? []).slice(0, MAX_STATEMENTS) };
  if (trailer) policy.trailer = `${trailer[0]!.toUpperCase()}${trailer.slice(1).toLowerCase()}`;
  return policy;
}

/** AI policy files by name: AI_POLICY.md, docs/ai-policy.md, llvm/docs/AIToolPolicy.md, LLM_POLICY.md. */
export const AI_POLICY_FILE = /(?:^|\/)(?:ai|llm|gen(?:erative)?[-_]?ai)[-_]?(?:tools?[-_]?)?(?:policy|usage|use|contributions?|guidelines?)\.(?:md|rst|txt|adoc)$/i;
