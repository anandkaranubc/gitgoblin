import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execShell } from "../src/exec.ts";
import { forwardedCommand, hostAllowed, REGISTRY_HOSTS, startEgressProxy } from "../src/egress.ts";

/** Sends a CONNECT through the proxy and returns the status line it answers with. */
function connectThrough(proxyUrl: string, target: string): Promise<string> {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8").split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

describe("hostAllowed", () => {
  it("allows package registries and their subdomains, nothing else", () => {
    expect(hostAllowed("registry.npmjs.org", REGISTRY_HOSTS)).toBe(true);
    expect(hostAllowed("files.pythonhosted.org", REGISTRY_HOSTS)).toBe(true);
    expect(hostAllowed("REGISTRY.NPMJS.ORG", REGISTRY_HOSTS)).toBe(true);
    expect(hostAllowed("evil.example.com", REGISTRY_HOSTS)).toBe(false);
    expect(hostAllowed("registry.npmjs.org.evil.com", REGISTRY_HOSTS)).toBe(false);
    expect(hostAllowed("169.254.169.254", REGISTRY_HOSTS)).toBe(false);
    expect(hostAllowed("notregistry.npmjs.org", REGISTRY_HOSTS)).toBe(false);
  });
});

describe("startEgressProxy", () => {
  it("tunnels to allowed hosts on 443 and refuses everything else, recording what it refused", async () => {
    // A local "registry" stands in for the internet; the allowlist names it.
    const upstream = net.createServer((s) => s.end("hello from upstream"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy(["localhost"], { allowedPorts: [443, upstreamPort] });
    try {
      expect(await connectThrough(proxy.url, `localhost:${upstreamPort}`)).toMatch(/^HTTP\/1\.1 200/);
      expect(await connectThrough(proxy.url, "evil.example.com:443")).toMatch(/^HTTP\/1\.1 403/);
      expect(await connectThrough(proxy.url, "localhost:22")).toMatch(/^HTTP\/1\.1 403/);
      const plain = await new Promise<number>((resolve) => {
        const { hostname, port } = new URL(proxy.url);
        http.get({ host: hostname, port, path: "http://evil.example.com/x", headers: { host: "evil.example.com" } }, (res) => resolve(res.statusCode ?? 0)).on("error", () => resolve(-1));
      });
      expect(plain).toBe(403);
      expect(proxy.denied()).toEqual(expect.arrayContaining(["evil.example.com:443", "localhost:22", "evil.example.com:80"]));
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});

describe("egress through a Unix socket and an in-sandbox forwarder", () => {
  // bubblewrap gives the install its own network namespace; the proxy listens on a socket in a folder
  // bound into the sandbox, and a forwarder inside the namespace offers it on 127.0.0.1.
  it("runs the command behind a forwarder that reaches the proxy, and enforces the allowlist", async () => {
    const upstream = net.createServer((s) => s.end("hello from upstream"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const socketPath = path.join(mkdtempSync(path.join(os.tmpdir(), "gg-egress-")), "proxy.sock");
    const proxy = await startEgressProxy(["localhost"], { allowedPorts: [443, upstreamPort], socketPath });
    try {
      const probe = [
        "const net = require('net');",
        "const u = new URL(process.env.HTTPS_PROXY);",
        "const ask = (target) => new Promise((resolve) => { const s = net.connect(Number(u.port), u.hostname, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n')); s.once('data', (d) => { resolve(d.toString().split(' ')[1]); s.destroy(); }); s.on('error', () => resolve('error')); });",
        `ask('localhost:${upstreamPort}').then((a) => ask('evil.example.com:443').then((b) => { console.log('allowed=' + a + ' evil=' + b); process.exit(7); }));`,
      ].join(" ");
      const { command, env } = forwardedCommand(`node -e "${probe.replace(/"/g, '\\"')}"`, socketPath, process.execPath);
      const r = await execShell(command, { cwd: os.tmpdir(), env: { PATH: process.env["PATH"] ?? "", ...env }, timeoutMs: 30_000 });
      expect(r.output).toContain("allowed=200 evil=403");
      // The wrapped command's exit status comes through.
      expect(r.exitCode).toBe(7);
      expect(proxy.denied()).toContain("evil.example.com:443");
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});

describe("chaining through the operator's own proxy", () => {
  // Behind a corporate proxy the egress proxy cannot reach registries directly; it tunnels through it.
  it("opens allowed tunnels via the upstream proxy and still refuses the rest", async () => {
    const target = net.createServer((s) => s.end("hello from the registry"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    const targetPort = (target.address() as net.AddressInfo).port;
    const seen: string[] = [];
    const upstream = net.createServer((client) => {
      client.once("data", (d) => {
        const line = d.toString().split("\r\n")[0] ?? "";
        seen.push(line);
        const [, hostPort] = line.split(" ");
        const [, port] = (hostPort ?? "").split(":");
        const out = net.connect(Number(port), "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          out.pipe(client);
          client.pipe(out);
        });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    const proxy = await startEgressProxy(["localhost"], { allowedPorts: [443, targetPort], upstream: upstreamUrl });
    try {
      const { hostname, port } = new URL(proxy.url);
      const reply = await new Promise<string>((resolve, reject) => {
        const s = net.connect(Number(port), hostname, () => s.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\n\r\n`));
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("hello from the registry")) {
            resolve(buf);
            s.destroy();
          }
        });
        s.on("error", reject);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 200/);
      expect(seen).toEqual([`CONNECT localhost:${targetPort} HTTP/1.1`]);
      expect(await connectThrough(proxy.url, "evil.example.com:443")).toMatch(/^HTTP\/1\.1 403/);
      expect(seen).toHaveLength(1);
    } finally {
      await proxy.close();
      upstream.close();
      target.close();
    }
  });
});
