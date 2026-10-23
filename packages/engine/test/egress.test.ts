import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { hostAllowed, REGISTRY_HOSTS, startEgressProxy } from "../src/egress.ts";

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
