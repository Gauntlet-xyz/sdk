import { GauntletApiError } from './errors';

export const DEFAULT_API_URL = 'https://api.gauntlet.xyz';

export interface GauntletApiConfig {
  /** Kong consumer key sent as `x-api-key`. Anonymous access is rate-limited. */
  apiKey?: string;
  /**
   * Override the API origin. Defaults to `https://api.gauntlet.xyz`. In a
   * browser this may be a relative path (e.g. a Next.js rewrite like
   * `/gauntlet-api`), which resolves against the page origin.
   */
  apiUrl?: string;
  /** Custom fetch implementation (testing, instrumentation). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export async function apiGet<T>(
  config: GauntletApiConfig,
  path: string,
  query?: QueryParams
): Promise<T> {
  // Concatenate instead of `new URL(path, base)`: the paths are absolute, so
  // URL resolution would silently drop any path prefix on a proxy apiUrl.
  const base = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  // Relative bases resolve against the browser origin.
  const origin = (globalThis as { location?: { origin: string } }).location?.origin;
  if (origin === undefined && !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    throw new Error(
      `relative apiUrl "${base}" requires a browser origin; pass an absolute apiUrl outside the browser`
    );
  }
  const url = new URL(base + path, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const fetchImpl = config.fetch ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    },
  });

  if (!response.ok) {
    let message = response.statusText || 'request failed';
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code;
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new GauntletApiError({ status: response.status, path, message, code });
  }

  return (await response.json()) as T;
}
