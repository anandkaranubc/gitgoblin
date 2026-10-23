import http from "node:http";
import net from "node:net";

/**
 * Where a project's dependencies come from. In strict isolation the install step reaches only these,
 * through a proxy the engine runs itself; the OS sandbox lets the install talk to nothing but
 * localhost, so a postinstall script cannot reach any other host. Entries starting with "." match
 * any subdomain.
 */
export const REGISTRY_HOSTS: readonly string[] = [
  // JavaScript
  "registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com", "registry.npmmirror.com", "nodejs.org",
  // Python
  "pypi.org", "files.pythonhosted.org", "pypi.python.org",
  // Rust
  "crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org",
  // Go
  "proxy.golang.org", "sum.golang.org", "storage.googleapis.com",
  // Ruby, PHP, .NET, JVM
  "rubygems.org", "index.rubygems.org", "repo.packagist.org", "api.nuget.org",
  "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org", "dl.google.com",
  // Dependencies declared as git or tarball URLs on GitHub
  "github.com", "codeload.github.com", "objects.githubusercontent.com", ".githubusercontent.com",
];

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (net.isIP(h.replace(/^\[|\]$/g, ""))) return false; // registries are reached by name, never by address
  return allowed.some((entry) => (entry.startsWith(".") ? h.endsWith(entry) : h === entry));
}

export interface EgressProxy {
  /** http://127.0.0.1:<port>, for HTTPS_PROXY and friends. */
  url: string;
  /** host:port pairs that were refused, for the run's events and report. */
  denied(): string[];
  close(): Promise<void>;
}

export interface EgressOptions {
  /** Ports a tunnel may open; 443 by default. Tests add a local one. */
  allowedPorts?: number[];
}

/**
 * An HTTP proxy on 127.0.0.1 that opens CONNECT tunnels to allowed hosts and refuses everything
 * else, including plain HTTP. It resolves names itself, so a hostile project cannot point a tunnel
 * at an address of its choosing.
 */
export function startEgressProxy(allowed: readonly string[] = REGISTRY_HOSTS, options: EgressOptions = {}): Promise<EgressProxy> {
  const ports = new Set(options.allowedPorts ?? [443]);
  const denied = new Set<string>();
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    // Plain HTTP requests through the proxy: never allowed (registries are HTTPS).
    let target = req.url ?? "";
    try {
      const u = new URL(target);
      target = `${u.hostname}:${u.port || "80"}`;
    } catch {
      // not an absolute URL; keep the raw value
    }
    denied.add(target);
    res.writeHead(403, { "content-type": "text/plain" }).end("gitgoblin: plain HTTP is not allowed during install\n");
  });
  server.on("connect", (req, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const target = req.url ?? "";
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 0);
    if (!m || !ports.has(port) || !hostAllowed(host, allowed)) {
      denied.add(target);
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\ngitgoblin: this host is not a package registry\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        denied: () => [...denied],
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Environment that sends package managers through the proxy. NO_PROXY is cleared so nothing bypasses it. */
export function proxyEnv(url: string): Record<string, string> {
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    ALL_PROXY: url,
    npm_config_https_proxy: url,
    npm_config_proxy: url,
    YARN_HTTPS_PROXY: url,
    YARN_HTTP_PROXY: url,
    NO_PROXY: "",
    no_proxy: "",
  };
}
