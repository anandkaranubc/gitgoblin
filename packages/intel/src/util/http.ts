export interface HttpResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<HttpResponse>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** fetch with a hard timeout; throws on timeout like any network error. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: { attempts: number; delayMs: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error)) throw error;
      if (attempt < options.attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
