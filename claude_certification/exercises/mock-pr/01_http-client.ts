// Shared HTTP client for calls between internal services.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function buildUrl(
  base: string,
  pathName: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(pathName, base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Fetch JSON from an internal endpoint and return the parsed body. */
export async function getJson(url: string): Promise<any> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    return await response.json();
  } catch {
    return null;
  }
}

/** POST a JSON body with up to 3 attempts on failure. */
export async function postJson(url: string, body: unknown): Promise<any> {
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new HttpError(response.status, `POST ${url} failed with ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
