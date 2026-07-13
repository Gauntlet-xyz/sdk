# @gauntlet-xyz/sdk

Official Gauntlet SDK for interacting with Gauntlet-managed vaults — deposits, withdrawals, on-chain attribution, and the Gauntlet REST API (vaults, positions, PnL, activity).

## Documentation

Full documentation, guides, and API reference at **[docs.gauntlet.xyz](https://docs.gauntlet.xyz/)**.

## Installation

```bash
npm install @gauntlet-xyz/sdk viem
# or
yarn add @gauntlet-xyz/sdk viem
```

> `viem` is a required peer dependency.

## Quick start

```ts
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { base } from 'viem/chains';
import { GauntletClient, getVaults, getDepositTx } from '@gauntlet-xyz/sdk';

const client = new GauntletClient({
  evmClients: { [base.id]: createPublicClient({ chain: base, transport: http() }) },
  wallet: createWalletClient({ chain: base, transport: custom(window.ethereum) }),
  builderCode: 'my-app', // ERC-8021 attribution
});

const vaults = await getVaults(client, { chainId: base.id });
const steps = await getDepositTx(client, { vaultId: vaults[0].vaultId, amount: 100_000_000n });
for (const step of steps) {
  await client.wallet!.sendTransaction({
    to: step.payload.to,
    data: step.payload.data, // attribution suffix already applied
    account: step.payload.account!,
    chain: base,
  });
}
```

Using [Privy](https://privy.io)? `@gauntlet-xyz/sdk/privy` builds the client in one call:

```ts
import { createGauntletClientFromPrivy } from '@gauntlet-xyz/sdk/privy';
import { base } from 'viem/chains';

const client = await createGauntletClientFromPrivy({
  wallet: wallets[0], // from useWallets()
  chains: [base],
  builderCode: 'my-app',
});
```

## REST API (`client.api`)

`client.api` is a typed client for the Gauntlet API at `api.gauntlet.xyz` — indexed vault metrics, user positions with PnL, the wallet activity log, TVL, and token prices. Response types are generated from the service's OpenAPI spec and verified in CI, so they cannot drift.

```ts
const client = new GauntletClient({ apiKey: process.env.GAUNTLET_API_KEY });

const { data: vaults } = await client.api.vaults(); // live TVL / APY / unit price
const { data: positions } = await client.api.positions(wallet); // value, cost basis, PnL, ROI
const { data: history } = await client.api.positionTimeseries(wallet, vaultId);
```

Vault ids on the API are CAIP-10 (`"{chainId}:{address}"`); convert to and from manifest vault ids with `apiVaultIdFromVaultId` / `vaultIdFromApiVaultId`. Monetary values are human-unit decimal strings; convert exactly with `decimalToBigInt` / `sharesToBigInt` (throws instead of rounding).

### Activity flows

`getActivityFlows` stitches the raw activity log into lifecycle-aware flows — Aera async requests are paired with their settlement or refund via `request_hash`, replacing client-side event-log scanning:

```ts
import { getActivityFlows, waitForRequestSettlement } from '@gauntlet-xyz/sdk';

const flows = await getActivityFlows(client.api, wallet);
// [{ kind: 'deposit', status: 'pending', requestedAt, settledAt, assets, shares, txHashes, ... }]

// After submitting a requestDeposit / requestRedeem transaction:
const settled = await waitForRequestSettlement(client.api, wallet, requestHash);
```

### Position history

`getPositionHistory` replays a wallet's indexed events into a chronological position timeline — running share balance, escrowed pending amounts, and net asset flows:

```ts
import { getPositionHistory, apiVaultIdFromVaultId } from '@gauntlet-xyz/sdk';

const vaultId = await apiVaultIdFromVaultId(client, 'gtusda');
const { points } = await getPositionHistory(client.api, wallet, vaultId);
```

## Development

`src/api/generated.ts` is generated from `services/gaia/api/openapi.json` — regenerate with `yarn generate:api-types` after API changes; CI fails if it drifts.
