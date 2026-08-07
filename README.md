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

## Aera instant withdrawals

Use the live capability result to decide whether to offer an instant withdrawal, then pass the
quote back to `getWithdrawTx` so the submitted transaction uses the quoted bounds.

```ts
import {
  getAeraTokenModeSupport,
  getSyncWithdrawQuote,
  getWithdrawTx,
  VaultId,
} from '@gauntlet-xyz/sdk'

const vaultId = VaultId.AeraUsdAlpha
const support = await getAeraTokenModeSupport(client, { vaultId })

if (support.syncRedeem) {
  const quote = await getSyncWithdrawQuote(client, {
    vaultId,
    amount: 1_000_000n,
    slippageBps: 100,
  })
  const steps = await getWithdrawTx(client, {
    vaultId,
    amount: 1_000_000n,
    syncWithdrawQuote: quote,
  })
}
```

An `amount` quote uses exact token output and returns a `maxUnitsIn` bound. A `shares` quote uses
exact shares and returns a `minTokensOut` bound. Full-position quotes require
`{ entireAmount: true, account }`; the matching transaction uses the configured wallet account,
and an optional `account` must match that wallet. The returned `SyncWithdrawQuote` is directly
assignable to the exported `SyncWithdrawQuoteBounds` accepted by `getWithdrawTx`.

Supplying `syncWithdrawQuote` implies sync mode and validates its vault, chain, token, account,
slippage, and sizing request. When transaction slippage is omitted, the builder uses the quote's
slippage; an explicitly supplied value must match. A `shares` or `entireAmount` quote with
`slippageBps: 10000` is rejected because it would produce `minTokensOut: 0`.

Live capability checks also apply the V2 solving gate. While the gate pauses the provisioner/token
pair, both sync flags are false and sync quote or transaction requests are rejected.

Common failures are `UnsupportedDepositModeError`,
`UnsupportedFeatureError`, `StalePriceError`, `InvalidSyncWithdrawBoundError`,
`InvalidWithdrawParamsError`, `AccountRequiredError`, and `AccountMismatchError`.

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

## Fee wrapper vaults (partners)

Partner fee wrapper vaults are Aera vaults deployed exclusively for one partner, so they are not in the bundled manifest. Register yours with `client.setManifest`: extend `await client.manifest` with your vault entry (deployment values provided by Gauntlet) and every SDK function then accepts its `vaultId`. See the [fee wrapper guide](https://docs.gauntlet.xyz/sdk/reference#fee-wrapper-vaults-partners) for the full example.

## Development

`src/api/generated.ts` is generated from `services/gaia/api/openapi.json` — regenerate with `yarn generate:api-types` after API changes; CI fails if it drifts.
