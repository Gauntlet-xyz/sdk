export function readAtBlock(options: { blockNumber?: bigint } = {}) {
  return options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber };
}
