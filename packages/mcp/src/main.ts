import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runAnalysisChild } from "./child.ts";
import { defaultDeps } from "./deps.ts";
import { CHILD_FLAG } from "./isolate.ts";
import { createServer } from "./server.ts";

/** Serves gitgoblin over stdio until the client closes the pipe. */
export function main(): void {
  // This same module is the analysis child's entry, so the published bundle stays one file.
  serveStdio(() => createServer(defaultDeps(fileURLToPath(import.meta.url))));
  // Clients end the session by closing stdin; make sure nothing keeps the process alive after that.
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv.includes(CHILD_FLAG)) await runAnalysisChild();
else main();
