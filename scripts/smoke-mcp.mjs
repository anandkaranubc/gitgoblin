// Starts an installed MCP server and checks that it answers an initialize request over stdio with
// the expected version. Used by the release workflow: `--version` alone never loads the bundle.
//
//   node scripts/smoke-mcp.mjs <path to gitgoblin-mcp> <expected version>
import { spawn } from "node:child_process";

const [bin, expected] = process.argv.slice(2);
if (!bin || !expected) {
  console.error("usage: node scripts/smoke-mcp.mjs <path to gitgoblin-mcp> <expected version>");
  process.exit(2);
}

const child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
const fail = (why) => {
  console.error(why);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail("no reply to initialize within 60 s"), 60_000);
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf("\n");
  if (end < 0) return;
  clearTimeout(timer);
  const line = buffer.slice(0, end);
  const info = JSON.parse(line).result?.serverInfo;
  if (info?.version !== expected) fail(`expected serverInfo version ${expected}, got: ${line}`);
  console.log(`MCP initialize ok: ${JSON.stringify(info)}`);
  child.kill();
  process.exit(0);
});
child.on("exit", (code) => fail(`server exited with ${code} before replying`));
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-smoke-test", version: "1" } },
};
child.stdin.write(`${JSON.stringify(initialize)}\n`);
