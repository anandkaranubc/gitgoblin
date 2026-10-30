// A stand-in for the server: starts an analysis (the child fixture's grandchild mode), then goes away while it runs.
import { existsSync } from "node:fs";
import { runInChild } from "../../src/isolate.ts";

const [fixture = "", pidFile = "", how = "exit"] = process.argv.slice(2);
runInChild(fixture, { mode: "grandchild", pidFile }, { timeoutMs: 60_000 }).catch(() => {});
const poll = setInterval(() => {
  if (!existsSync(pidFile)) return;
  clearInterval(poll);
  if (how === "exit") process.exit(0); // what the server does when the client closes stdin
  else process.kill(process.pid, how as NodeJS.Signals);
}, 20);
