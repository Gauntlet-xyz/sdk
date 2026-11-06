import { createAnvil } from '@viem/anvil';
import { createPublicClient, createTestClient, http } from 'viem';
import { base } from 'viem/chains';
import { expect, test } from 'vitest';
import { resolveContractVersion } from '../src/evm/aeraContracts';

// Deployed code that returns the ABI encoding of "2.0" or "1.0" for any call.
const V2_CODE = '0x6020600052600360205262322e3060e81b60405260606000f3';
const V1_CODE = '0x6020600052600360205262312e3060e81b60405260606000f3';

test('caches latest versions per client but not failures or historical reads', async () => {
  const anvil = createAnvil({ port: 0 });
  await anvil.start();
  try {
    const port = anvil.logs.find((line) => line.includes('Listening on'))?.match(/Listening on .*:(\d+)/)?.[1];
    if (port === undefined) throw new Error('Anvil did not report a port');
    const transport = http(`http://127.0.0.1:${port}`);
    const client = createPublicClient({ chain: base, transport });
    const testClient = createTestClient({ chain: base, mode: 'anvil', transport });
    const address = '0x0000000000000000000000000000000000000123';

    await expect(resolveContractVersion(client, address)).rejects.toThrow();
    await testClient.setCode({ address, bytecode: V2_CODE });
    await expect(resolveContractVersion(client, address)).resolves.toBe('v2');

    await testClient.setCode({ address, bytecode: V1_CODE });
    await testClient.mine({ blocks: 1 });
    const v1Block = await client.getBlockNumber();
    // The cached latest answer stays v2, while a block-pinned read sees the new code.
    await expect(resolveContractVersion(client, address)).resolves.toBe('v2');
    await expect(resolveContractVersion(client, address, { blockNumber: v1Block })).resolves.toBe('v1');
    await expect(
      resolveContractVersion(createPublicClient({ chain: base, transport }), address)
    ).resolves.toBe('v1');
  } finally {
    await anvil.stop();
  }
});
