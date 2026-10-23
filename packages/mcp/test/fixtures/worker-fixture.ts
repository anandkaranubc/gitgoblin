// A stand-in for the analysis worker: same message protocol, controllable behaviour.
import { parentPort, workerData } from "node:worker_threads";

const { mode } = workerData as { mode: "echo" | "print" | "throw" | "hang" };
const post = (message: unknown) => parentPort?.postMessage(message);

if (mode === "echo") {
  post({ type: "log", message: "working" });
  post({ type: "result", value: { ok: true } });
} else if (mode === "print") {
  process.stdout.write("printed by a library\n");
  post({ type: "result", value: { ok: true } });
} else if (mode === "throw") {
  post({ type: "error", message: "analysis failed: boom" });
} else {
  // A synchronous hang, like a catastrophically backtracking regular expression.
  for (;;) {}
}
