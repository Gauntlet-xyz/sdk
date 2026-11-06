import { createServer, type Server, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { GauntletApi, type UserActivity } from '../../src/api/client';
import { waitForRequestSettlement } from '../../src/api/activity';

const servers: Server[] = [];
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No HTTP server address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

const vaultId = '8453:0x0000000000000000000000000000000000000001';
function row(type: string, txHash: string, block: number): UserActivity {
  return {
    type, tx_hash: txHash, block_number: block, block_timestamp: block, block_hash: `block-${block}`,
    vault_id: vaultId, request_hash: 'reused', shares_delta: type === 'deposit' ? '9' : '0',
    assets_delta: { native: type === 'deposit' ? '0' : '10', token: null },
  };
}

it('waits for the submitted transaction when a request hash has an earlier settlement', async () => {
  let reads = 0;
  const rows = [row('deposit_pending', 'old-request', 1), row('deposit', 'old-settle', 2)];
  const apiUrl = await serve((_request, response) => {
    reads += 1;
    if (reads === 2) rows.push(row('deposit_pending', 'new-request', 3));
    if (reads === 3) rows.push(row('deposit', 'new-settle', 4));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [...rows].reverse(), meta: { next_cursor: null } }));
  });
  const result = await waitForRequestSettlement(new GauntletApi({ apiUrl }), 'wallet', 'reused', {
    requestTxHash: 'new-request', vaultId: `eip155:${vaultId}`, pollIntervalMs: 1, timeoutMs: 1000,
  });
  expect(reads).toBe(3);
  expect(result.txHashes).toEqual(['new-request', 'new-settle']);
});

it('rejects incomplete activity and prevents API credentials from following a redirect', async () => {
  let redirectedRequests = 0;
  const destination = await serve((_request, response) => {
    redirectedRequests += 1;
    response.end('{}');
  });
  const apiUrl = await serve((request, response) => {
    expect(request.headers['x-api-key']).toBe('test-key');
    if (request.url === '/health') {
      response.writeHead(302, { location: `${destination}/health` });
      response.end();
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [], meta: { next_cursor: null, partial_errors: [{ code: 'INCOMPLETE' }] } }));
    }
  });
  const api = new GauntletApi({ apiUrl, apiKey: 'test-key' });
  await expect(api.health()).rejects.toThrow();
  expect(redirectedRequests).toBe(0);
  await expect(Array.fromAsync(api.activityRows('wallet'))).rejects.toThrow('incomplete');
});

it('keeps same-transaction rows split by a page and rejects a page that moves backwards', async () => {
  const deposit = { ...row('deposit', 'multicall', 2), request_hash: null };
  const pages = (second: UserActivity) => serve((request, response) => {
    response.setHeader('content-type', 'application/json');
    const first = !request.url?.includes('next=');
    response.end(JSON.stringify({ data: [first ? deposit : second], meta: { next_cursor: first ? 'page-2' : null } }));
  });
  const split = new GauntletApi({ apiUrl: await pages(deposit) });
  expect(await Array.fromAsync(split.activityRows('wallet'))).toEqual([deposit, deposit]);

  const newer = { ...deposit, tx_hash: 'replayed', block_number: 3, block_timestamp: 3 };
  const backwards = new GauntletApi({ apiUrl: await pages(newer) });
  await expect(Array.fromAsync(backwards.activityRows('wallet'))).rejects.toThrow('out of order');
});
