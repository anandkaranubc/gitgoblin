import type * as engine from "@gitgoblin/engine";
import type * as intel from "@gitgoblin/intel";

/**
 * `analyze` and `contribute` lean on two sibling packages that are loaded at run time, so the
 * commands that only need discovery keep working in an install without them. The types come from
 * the packages themselves; only the type imports are erased, so the CLI is checked against the real
 * contracts without depending on them at run time.
 */
export type IntelModule = Pick<typeof intel, "analyzeRepository" | "renderMarkdown" | "AnalysisReport">;
export type EngineModule = Pick<typeof engine, "runContribution" | "publishRun">;

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
