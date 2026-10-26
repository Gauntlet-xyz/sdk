import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, context } from 'esbuild';

const entryPoints = [
  'src/index.ts',
  'src/evm/index.ts',
  'src/api/index.ts',
  'src/privy/index.ts',
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return files.flat().filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/cjs', { recursive: true });
execFileSync(process.execPath, ['scripts/emit-declarations.mjs'], { stdio: 'inherit' });

await mkdir('dist/manifest', { recursive: true });
await copyFile('manifest/vaults.json', 'dist/manifest/vaults.json');
await writeFile('dist/cjs/package.json', '{"type":"commonjs"}\n');

const outputs = [
  {
    entryPoints,
    outbase: 'src',
    outdir: 'dist',
    bundle: true,
    packages: 'external',
    splitting: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    sourcemap: true,
  },
  {
    entryPoints: await sourceFiles('src'),
    outbase: 'src',
    outdir: 'dist/cjs',
    bundle: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2020',
    sourcemap: true,
  },
];

if (process.argv.includes('--watch')) {
  const types = spawn(process.execPath, ['scripts/emit-declarations.mjs', '--watch'], {
    stdio: 'inherit',
  });
  process.on('SIGINT', () => types.kill('SIGINT'));
  process.on('SIGTERM', () => types.kill('SIGTERM'));

  await Promise.all(outputs.map(async (output) => {
    const buildContext = await context(output);
    await buildContext.watch();
  }));
} else {
  await Promise.all(outputs.map((output) => build(output)));
}
