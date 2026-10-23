// Keep this import first: it hardens git before any other module reads process.env.
import "./env.ts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { defaultDeps } from "./deps.ts";
import { createServer } from "./server.ts";

/** Serves gitgoblin over stdio until the client closes the pipe. */
export function main(): void {
  serveStdio(() => createServer(defaultDeps()));
  // Clients end the session by closing stdin; make sure nothing keeps the process alive after that.
  process.stdin.on("end", () => process.exit(0));
}

main();
