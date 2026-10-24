import { describe, expect, it } from "vitest";
import { checkPublic, createPublicChecker } from "../src/public.ts";

type Reply = { status: number; body?: unknown; url?: string };

function fakeFetch(replies: Record<string, Reply>, seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = replies[url] ?? { status: 404 };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, url: reply.url ?? url, json: async () => reply.body } as Response;
  }) as typeof fetch;
}

const gh = { host: "github.com", owner: "acme", name: "widget" };

describe("checkPublic", () => {
  it("accepts a public GitHub repository and sends no credentials", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const v = await checkPublic(gh, fakeFetch({ "https://api.github.com/repos/acme/widget": { status: 200, body: { private: false, visibility: "public" } } }, seen));
    expect(v).toEqual({ public: true });
    expect(seen[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("refuses private and missing repositories", async () => {
    expect((await checkPublic(gh, fakeFetch({ "https://api.github.com/repos/acme/widget": { status: 200, body: { private: true } } }))).public).toBe(false);
    expect(await checkPublic(gh, fakeFetch({}))).toEqual({ public: false, reason: "no public repository by that name" });
  });

  it("falls back to the repository page when the anonymous API limit is spent", async () => {
    const replies = { "https://api.github.com/repos/acme/widget": { status: 403 }, "https://github.com/acme/widget": { status: 200 } };
    expect(await checkPublic(gh, fakeFetch(replies))).toEqual({ public: true });
    const login = { ...replies, "https://github.com/acme/widget": { status: 200, url: "https://github.com/login?return_to=x" } };
    expect((await checkPublic(gh, fakeFetch(login))).public).toBe(false);
  });

  it("reads GitLab and Codeberg visibility", async () => {
    const gitlab = { host: "gitlab.com", owner: "gitlab-org", name: "cli" };
    const url = "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli";
    expect(await checkPublic(gitlab, fakeFetch({ [url]: { status: 200, body: { visibility: "public" } } }))).toEqual({ public: true });
    expect((await checkPublic(gitlab, fakeFetch({ [url]: { status: 200, body: { visibility: "internal" } } }))).public).toBe(false);
    const codeberg = { host: "codeberg.org", owner: "dnkl", name: "foot" };
    const cb = "https://codeberg.org/api/v1/repos/dnkl/foot";
    expect(await checkPublic(codeberg, fakeFetch({ [cb]: { status: 200, body: { private: false, internal: false } } }))).toEqual({ public: true });
    expect((await checkPublic(codeberg, fakeFetch({ [cb]: { status: 200, body: { private: true } } }))).public).toBe(false);
  });

  it("refuses hosts it cannot ask and fails closed when the forge is unreachable", async () => {
    expect((await checkPublic({ host: "git.example.org", owner: "a", name: "b" }, fakeFetch({}))).public).toBe(false);
    const broken = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await checkPublic(gh, broken)).toMatchObject({ public: false, reason: expect.stringMatching(/could not be reached/) });
  });
});

describe("createPublicChecker", () => {
  it("remembers confirmed answers and asks again after a network error", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const check = createPublicChecker(fakeFetch({ "https://api.github.com/repos/acme/widget": { status: 200, body: { private: false } } }, seen));
    await check(gh);
    await check({ ...gh, owner: "ACME" });
    expect(seen).toHaveLength(1);
  });
});
