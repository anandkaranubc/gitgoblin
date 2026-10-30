// The real analysis child with an analysis that never ends, like one stuck on a slow clone.
import { runAnalysisChild } from "../../src/child.ts";

await runAnalysisChild(async (_ref, options) => {
  options?.log?.("started");
  setInterval(() => {}, 1000);
  return new Promise<never>(() => {});
});
