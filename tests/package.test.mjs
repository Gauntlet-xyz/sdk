import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

for (const name of [
  '@gauntlet-xyz/sdk',
  '@gauntlet-xyz/sdk/evm',
  '@gauntlet-xyz/sdk/api',
  '@gauntlet-xyz/sdk/privy',
]) {
  test(`${name} loads through import and require`, async () => {
    const esm = await import(name);
    const cjs = require(name);

    assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
    assert.ok(Object.keys(esm).length > 0);
  });
}

test('entry points share module identity', async () => {
  const [esmRoot, esmApi, esmEvm] = await Promise.all([
    import('@gauntlet-xyz/sdk'),
    import('@gauntlet-xyz/sdk/api'),
    import('@gauntlet-xyz/sdk/evm'),
  ]);
  const cjsRoot = require('@gauntlet-xyz/sdk');
  const cjsApi = require('@gauntlet-xyz/sdk/api');
  const cjsEvm = require('@gauntlet-xyz/sdk/evm');

  assert.equal(esmRoot.GauntletApiError, esmApi.GauntletApiError);
  assert.equal(esmRoot.getDepositTx, esmEvm.getDepositTx);
  assert.equal(cjsRoot.GauntletApiError, cjsApi.GauntletApiError);
  assert.equal(cjsRoot.getDepositTx, cjsEvm.getDepositTx);
});

test('Node16 and NodeNext resolve ESM and CommonJS declarations', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), 'gauntlet-sdk-types-'));
  const scope = join(fixture, 'node_modules', '@gauntlet-xyz');
  const consumer = [
    "import { GauntletClient } from '@gauntlet-xyz/sdk';",
    "import { getDepositTx } from '@gauntlet-xyz/sdk/evm';",
    "import { GauntletApiError } from '@gauntlet-xyz/sdk/api';",
    "import { walletClientFromPrivy } from '@gauntlet-xyz/sdk/privy';",
    'void [GauntletClient, getDepositTx, GauntletApiError, walletClientFromPrivy];',
  ].join('\n');

  try {
    mkdirSync(scope, { recursive: true });
    symlinkSync(packageRoot, join(scope, 'sdk'), 'dir');
    for (const extension of ['cts', 'mts']) {
      writeFileSync(join(fixture, `consumer.${extension}`), consumer);
    }
    for (const mode of ['Node16', 'NodeNext']) {
      execFileSync(process.execPath, [
        require.resolve('typescript/bin/tsc'),
        '--module', mode,
        '--moduleResolution', mode,
        '--target', 'ES2020',
        '--strict',
        '--noEmit',
        join(fixture, 'consumer.cts'),
        join(fixture, 'consumer.mts'),
      ], { stdio: 'pipe' });
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the published archive includes every export target', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const cache = mkdtempSync(join(tmpdir(), 'gauntlet-sdk-pack-'));

  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
    });
    const paths = new Set(JSON.parse(output)[0].files.map((file) => file.path));

    for (const entry of Object.values(packageJson.exports)) {
      for (const condition of Object.values(entry)) {
        for (const target of Object.values(condition)) {
          assert.ok(paths.has(target.slice(2)), `${target} is missing from the archive`);
        }
      }
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
