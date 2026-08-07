import { afterEach, describe, expect, it, vi } from 'vitest';
import { GauntletApi } from '../../src/api/client';
import type { GauntletApiConfig } from '../../src/api/http';

function captureFetch(): { fetch: GauntletApiConfig['fetch']; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [], meta: { next_cursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiGet base resolution', () => {
  it('resolves a relative apiUrl against the browser origin, keeping the path prefix', async () => {
    vi.stubGlobal('location', { origin: 'https://app.gauntlet.xyz' });
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ apiUrl: '/gauntlet-api', fetch });

    await api.vaults();

    expect(urls).toEqual(['https://app.gauntlet.xyz/gauntlet-api/v1/vaults']);
  });

  it('ignores the browser origin when the apiUrl is absolute', async () => {
    vi.stubGlobal('location', { origin: 'https://app.gauntlet.xyz' });
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ apiUrl: 'https://api.example.com/', fetch });

    await api.health();

    expect(urls).toEqual(['https://api.example.com/health']);
  });

  it('throws a descriptive error for a relative apiUrl outside a browser', async () => {
    const { fetch } = captureFetch();
    const api = new GauntletApi({ apiUrl: '/gauntlet-api', fetch });

    await expect(api.vaults()).rejects.toThrow(
      'relative apiUrl "/gauntlet-api" requires a browser origin'
    );
  });
});

describe('positions paging options', () => {
  it('forwards next and limit as query params', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.positions('0xUser', { next: 'cursor123', limit: 200 });

    expect(urls).toEqual([
      'https://api.gauntlet.xyz/v1/users/0xUser/positions?next=cursor123&limit=200',
    ]);
  });

  it('omits paging params when no options are given', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.positions('0xUser');

    expect(urls).toEqual(['https://api.gauntlet.xyz/v1/users/0xUser/positions']);
  });

  it('forwards includeHidden as include_hidden', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.positions('0xUser', { includeHidden: true });

    expect(urls).toEqual([
      'https://api.gauntlet.xyz/v1/users/0xUser/positions?include_hidden=true',
    ]);
  });
});

describe('curated surfaces', () => {
  it('requests featured vaults and strategies through the configured API origin', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.featuredVaults();
    await api.strategies();

    expect(urls).toEqual([
      'https://api.gauntlet.xyz/v1/vaults/featured',
      'https://api.gauntlet.xyz/v1/strategies',
    ]);
  });
});

describe('activity options', () => {
  it('forwards vaultId and includeHidden as query params', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.activity('0xUser', { vaultId: '8453:0xVault', includeHidden: true, limit: 50 });

    expect(urls).toEqual([
      'https://api.gauntlet.xyz/v1/users/0xUser/activity?vault_id=8453%3A0xVault&include_hidden=true&limit=50',
    ]);
  });

  it('omits activity params when no options are given', async () => {
    const { fetch, urls } = captureFetch();
    const api = new GauntletApi({ fetch });

    await api.activity('0xUser');

    expect(urls).toEqual(['https://api.gauntlet.xyz/v1/users/0xUser/activity']);
  });
});
