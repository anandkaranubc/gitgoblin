// A stand-in for the analysis child: the same IPC protocol, with controllable behaviour.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

interface Task {
  mode: "echo" | "print" | "throw" | "hang" | "grandchild" | "env";
  pidFile?: string;
}

const send = (message: unknown) => process.send?.(message);

process.once("message", (message: { task?: Task }) => {
  const task = message.task ?? { mode: "echo" };
  if (task.mode === "echo") {
    send({ type: "log", message: "working" });
    send({ type: "result", value: { ok: true } });
  } else if (task.mode === "print") {
    process.stdout.write("printed by a library\n");
    send({ type: "result", value: { ok: true } });
  } else if (task.mode === "throw") {
    send({ type: "error", message: "analysis failed: boom" });
  } else if (task.mode === "env") {
    send({ type: "result", value: { home: process.env.HOME, token: process.env.GITHUB_TOKEN ?? null, gitConfig: Object.keys(process.env).filter((k) => k.startsWith("GIT_CONFIG_")) } });
  } else if (task.mode === "grandchild") {
    // Like git started by intel: a process of its own that terminating only the child would leave running.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(task.pidFile ?? "", String(grandchild.pid));
    for (;;) {}
  } else {
    for (;;) {} // a synchronous hang, like a catastrophically backtracking regular expression
  }
});
