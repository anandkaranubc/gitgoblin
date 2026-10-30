import type * as engine from "@gitgoblin/engine";
import type * as intel from "@gitgoblin/intel";

/**
 * `analyze` and `contribute` lean on two sibling packages that are loaded at run time, so the
 * commands that only need discovery keep working in an install without them. The types come from
 * the packages themselves; only the type imports are erased, so the CLI is checked against the real
 * contracts without depending on them at run time.
 */
export type IntelModule = Pick<typeof intel, "analyzeRepository" | "renderMarkdown" | "AnalysisReport">;
export type EngineModule = Pick<typeof engine, "runContribution" | "publishRun"> & { DEFAULT_LIMITS?: typeof engine.DEFAULT_LIMITS; cleanRun?: typeof engine.cleanRun };

export type ModuleLoader = (name: string) => Promise<Record<string, unknown> | undefined>;

/**
 * True when importing `name` failed because that package is not installed. A module-not-found error
 * about one of the package's own imports, or any other error, means the package is there but broken,
 * which deserves its real message rather than "not available".
 */
export function isNotInstalled(error: unknown, name: string): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "ERR_MODULE_NOT_FOUND" && typeof message === "string" && message.includes(`'${name}'`);
}

/**
 * The engine drives its model through the Claude Agent SDK. The published CLI does not bundle it or
 * depend on it (its licence does not allow redistribution, and its platform binary is far too large
 * for `discover`), so a person who wants `contribute` installs it next to the CLI.
 */
export const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

export const AGENT_SDK_HINT = `contribute, publish and clean need the Claude Agent SDK, which is installed separately: npm install -g gitgoblin ${AGENT_SDK}`;

/**
 * Imports the sibling `name` through `load`. Undefined when the package is not installed; the
 * one-line install hint when it is the engine and only the Agent SDK is missing; any other failure
 * with its real first line, since that is a broken install rather than a missing one.
 */
export async function importSibling(name: string, load: () => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    return (await load()) as Record<string, unknown>;
  } catch (error) {
    if (isNotInstalled(error, name)) return undefined;
    if (name === "@gitgoblin/engine" && isNotInstalled(error, AGENT_SDK)) throw new Error(AGENT_SDK_HINT);
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    throw new Error(`${name} is installed but failed to load: ${detail}`);
  }
}

function hasFunctions(module: Record<string, unknown> | undefined, names: string[]): boolean {
  return module !== undefined && names.every((name) => typeof module[name] === "function");
}

export async function loadIntel(load: ModuleLoader): Promise<IntelModule | undefined> {
  const module = await load("@gitgoblin/intel");
  const schema = module?.AnalysisReport as { parse?: unknown } | undefined;
  return hasFunctions(module, ["analyzeRepository", "renderMarkdown"]) && typeof schema?.parse === "function" ? (module as unknown as IntelModule) : undefined;
}

export async function loadEngine(load: ModuleLoader): Promise<EngineModule | undefined> {
  const module = await load("@gitgoblin/engine");
  return hasFunctions(module, ["runContribution", "publishRun"]) ? (module as unknown as EngineModule) : undefined;
}
