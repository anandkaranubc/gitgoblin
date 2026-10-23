// Keep this import first: it hardens git before any other module reads process.env.
import "./env.ts";
import { isMainThread } from "node:worker_threads";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { defaultDeps } from "./deps.ts";
import { createServer } from "./server.ts";
import { runWorkerTask } from "./worker.ts";

/** Serves gitgoblin over stdio until the client closes the pipe. */
export function main(): void {
  // This same module is the analysis worker's entry, so the bundle stays one file.
  serveStdio(() => createServer(defaultDeps(new URL(import.meta.url))));
  // Clients end the session by closing stdin; make sure nothing keeps the process alive after that.
  process.stdin.on("end", () => process.exit(0));
}

if (isMainThread) main();
else await runWorkerTask();
