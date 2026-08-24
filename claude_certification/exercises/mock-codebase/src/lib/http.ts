export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body}`);
  }
}

/**
 * Shared outbound HTTP client. Applies a timeout and throws HttpError on a
 * non-2xx response. Deliberately has NO retry logic - each gateway decides
 * its own retry policy.
 */
export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new HttpError(response.status, await response.text(), url);
    }
    return (await response.json()) as T;
  }

  async getJson<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers });
    if (!response.ok) {
      throw new HttpError(response.status, await response.text(), url);
    }
    return (await response.json()) as T;
  }
}
