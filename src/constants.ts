export const MAX_BPS = 10000n;
export const DEFAULT_BPS = 100;

export const SECOND = 1;
export const MINUTE = SECOND * 60;
export const HOUR = MINUTE * 60;
export const DAY = HOUR * 24;

export const REQUEST_DEADLINE_BUFFER_DAYS = 3;
export const DEFAULT_MAX_PRICE_AGE_DAYS = 10;
export const DEFAULT_SOLVER_TIP = 0n;
export const DEFAULT_REQUEST_DEADLINE_BUFFER = DAY * REQUEST_DEADLINE_BUFFER_DAYS;
export const DEFAULT_MAX_PRICE_AGE = BigInt(DAY * DEFAULT_MAX_PRICE_AGE_DAYS);

export const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
};

// Approximate 3-day block lookback per chain based on avg block time.
export const BLOCKS_3_DAYS: Record<number, bigint> = {
  1: 21_600n,
  8453: 129_600n,
  42161: 1_036_800n,
  10: 129_600n,
};
export const DEFAULT_BLOCKS_3_DAYS = 129_600n;

// Many RPC providers cap eth_getLogs to 10,000 blocks per request.
export const LOG_PAGE_SIZE = 9_999n;
