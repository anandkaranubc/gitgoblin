/**
 * Keep the link checker on the public internet. A README can name any URL, and
 * the checker runs on the operator's machine, so hosts that resolve to private,
 * loopback or link-local addresses (cloud metadata endpoints, routers, local
 * services) are never requested.
 */
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type LookupFunction, isIP } from "node:net";

export type Lookup = (host: string) => Promise<string[]>;

export const defaultLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(parseIpv4(ip));
  if (version === 6) return isPublicIpv6(ip);
  return false;
}

function parseIpv4(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function inRange(n: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((parseIpv4(base) & mask) >>> 0);
}

/** Everything outside the ranges the IANA special-purpose registry marks as not globally reachable. */
function isPublicIpv4(n: number): boolean {
  const special: [string, number][] = [
    ["0.0.0.0", 8], // this network
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, incl. cloud metadata
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.88.99.0", 24], // 6to4 relay anycast
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 3], // multicast, reserved, broadcast
  ];
  return !special.some(([base, bits]) => inRange(n, base, bits));
}

/** Expand an IPv6 literal to eight 16-bit groups; undefined when it is not one. */
export function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.replace(/%.*$/, "").toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return undefined;
    const n = parseIpv4(dotted[1]!);
    text = `${text.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  return [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  const tailV4 = (g[6]! << 16) | g[7]!;
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return false; // ::
  if (zeroPrefix(7) && g[7] === 1) return false; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return isPublicIpv4(tailV4 >>> 0); // IPv4-mapped, any spelling
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return isPublicIpv4(tailV4 >>> 0); // IPv4-translated (SIIT)
  if (zeroPrefix(6)) return isPublicIpv4(tailV4 >>> 0); // deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && zeroPrefix(6) === false && g.slice(2, 6).every((x) => x === 0)) return isPublicIpv4(tailV4 >>> 0); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return isPublicIpv4(((g[1]! << 16) | g[2]!) >>> 0); // 6to4 embeds the IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo carries an obfuscated IPv4 address
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x100 && g[1] === 0) return false; // discard-only 100::/64
  return true;
}

/**
 * Where a host points: every address public, any address private (or the lookup failed oddly), or
 * no such host at all, which for a link is a finding rather than a reason to stay quiet.
 */
export async function classifyHost(host: string, lookupFn: Lookup = defaultLookup): Promise<"public" | "private" | "unresolvable"> {
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return isPublicIp(literal) ? "public" : "private";
  try {
    const addresses = await lookupFn(host);
    if (addresses.length === 0) return "unresolvable";
    return addresses.every(isPublicIp) ? "public" : "private";
  } catch (error) {
    return (error as { code?: string }).code === "ENOTFOUND" ? "unresolvable" : "private";
  }
}

/** True when every address the host resolves to is public; false for literals, private ranges and failed lookups. */
export async function resolvesToPublicAddress(host: string, lookupFn: Lookup = defaultLookup): Promise<boolean> {
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return isPublicIp(literal);
  try {
    const addresses = await lookupFn(host);
    return addresses.length > 0 && addresses.every(isPublicIp);
  } catch {
    return false;
  }
}

/**
 * A `lookup` for node:http(s) that resolves the host and refuses unless every address is public.
 * The socket then connects to exactly an address that was checked, so a DNS answer that changes
 * between a pre-check and the request (rebinding) cannot reach a private address.
 */
export function publicOnlyLookup(resolve?: Lookup): LookupFunction {
  return (hostname, options, callback) => {
    const done = (error: Error | null, addresses: string[]) => {
      if (error) return callback(error as NodeJS.ErrnoException, "", 0);
      if (addresses.length === 0 || !addresses.every(isPublicIp)) {
        return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "ENOTPUBLIC" }) as NodeJS.ErrnoException, "", 0);
      }
      const entries = addresses.map((address) => ({ address, family: isIP(address) }));
      // net asks for every address when it races IPv4 and IPv6 (autoSelectFamily); otherwise for one.
      if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof entries) => void)(null, entries);
      else callback(null, entries[0]!.address, entries[0]!.family);
    };
    if (resolve) resolve(hostname).then((a) => done(null, a), (e: Error) => done(e, []));
    else dnsLookup(hostname, { all: true, verbatim: true }, (e, a) => done(e, e ? [] : a.map((x) => x.address)));
  };
}

export interface HeadResponse {
  status: number;
  location: string | undefined;
}

/** One HEAD or GET without following redirects or reading the body, connecting only to public addresses. */
export function requestStatus(url: string, method: "HEAD" | "GET", timeoutMs: number, resolve?: Lookup): Promise<HeadResponse> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(target, {
      method,
      lookup: publicOnlyLookup(resolve),
      timeout: timeoutMs,
      headers: { "user-agent": "Mozilla/5.0 (compatible; gitgoblin-intel link check)", accept: "*/*" },
    }, (res) => {
      done({ status: res.statusCode ?? 0, location: res.headers.location });
      res.destroy();
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", fail);
    req.end();
  });
}
