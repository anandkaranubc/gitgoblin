import { readFileSync } from "node:fs";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch stub that records calls and answers from a handler. */
export function fetchStub(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: fn as typeof fetch, calls };
}

/** A clock and sleeper that advance virtual time instantly. */
export function virtualClock(start = 1_700_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}
