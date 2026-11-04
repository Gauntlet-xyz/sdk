import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PACKAGE, REGISTRY, prepare, requireEnvironmentProtection, requireMainReviewRules, requireNewStableVersion, requireTag, verifyArchive } from './release.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pkg = (version) => ({
  name: PACKAGE, version, publishConfig: { access: 'public', registry: REGISTRY },
  exports: { '.': { import: './dist/index.js' } }, files: ['dist', 'manifest'],
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function history(t) {
  const directory = fixture(t);
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Release test');
  git(directory, 'config', 'user.email', 'release-test@example.invalid');
  mkdirSync(join(directory, 'manifest'));
  const commit = (version) => {
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg(version)));
    writeFileSync(join(directory, 'manifest/vaults.json'), JSON.stringify({ version, vaults: [] }));
    git(directory, 'add', '.');
    git(directory, 'commit', '-m', `Release ${version}`);
    return git(directory, 'rev-parse', 'HEAD');
  };
  return { directory, commit };
}

test('release selection stays on the triggering commit after main advances', (t) => {
  const { directory, commit } = history(t);
  const before = commit('1.0.0');
  const selected = commit('1.1.0');
  commit('1.2.0');
  const previousDirectory = process.cwd();
  process.chdir(directory);
  try {
    const target = prepare({ EVENT_NAME: 'push', SOURCE_REF: 'refs/heads/main', SOURCE_SHA: selected, BEFORE_SHA: before });
    assert.equal(target.source_sha, selected);
    assert.equal(target.package_version, '1.1.0');
    assert.equal(target.publish, 'true');
    const manual = prepare({ EVENT_NAME: 'workflow_dispatch', SOURCE_SHA: selected, REQUESTED_REF: selected });
    assert.equal(manual.publish, 'false');
    assert.throws(() => prepare({ EVENT_NAME: 'workflow_dispatch', SOURCE_SHA: selected, REQUESTED_REF: `${selected}\npublish=true` }));
    assert.throws(() => prepare({ EVENT_NAME: 'workflow_dispatch', SOURCE_SHA: selected, REQUESTED_REF: `${selected}"; touch injected; #` }));
    assert.equal(existsSync(join(directory, 'injected')), false);
  } finally {
    process.chdir(previousDirectory);
  }
});

test('stable publication rejects rollbacks, prereleases, unchanged versions, and shell syntax in tags', () => {
  requireNewStableVersion('3.1.0', '3.0.9');
  for (const version of ['3.0.9', '2.9.9', '3.1.0-beta.1', '03.1.0']) {
    assert.throws(() => requireNewStableVersion(version, '3.0.9'));
  }
  assert.equal(requireTag('release-candidate'), 'release-candidate');
  for (const tag of ['latest\npublish=true', 'latest"; touch injected; #', '$(touch injected)']) {
    assert.throws(() => requireTag(tag));
  }
});

test('the live verifier rejects manual dispatch independently of prepare outputs', () => {
  const result = spawnSync(process.execPath, [resolve('.github/release/release.mjs'), 'verify-release'], {
    env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_SHA: 'a'.repeat(40), publish: 'true' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workflow_dispatch/);
});

test('archive verification binds package identity, source manifest, exports, and uploaded bytes', (t) => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'dist/manifest'), { recursive: true });
  mkdirSync(join(directory, 'manifest'));
  const manifest = Buffer.from('{"version":"production","vaults":[]}\n');
  const packageJson = {
    ...pkg('1.1.0'),
    scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'install-ran\', \'yes\')"' },
  };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson));
  writeFileSync(join(directory, 'manifest/vaults.json'), manifest);
  writeFileSync(join(directory, 'dist/manifest/vaults.json'), manifest);
  writeFileSync(join(directory, 'dist/index.js'), 'export const reviewed = true;\n');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(directory, 'cache') },
  }));
  const archive = join(directory, packed.filename);
  const expected = { version: '1.1.0', manifest: hash(manifest) };
  const sha256 = verifyArchive(archive, expected, directory);
  assert.equal(existsSync(join(directory, 'install-ran')), false);
  assert.equal(verifyArchive(archive, { ...expected, sha256 }), sha256);
  assert.throws(() => verifyArchive(archive, { ...expected, sha256: '0'.repeat(64) }), /digest/);
  assert.throws(() => verifyArchive(archive, { ...expected, version: '1.0.0' }), /version/);
  assert.throws(() => verifyArchive(archive, { ...expected, manifest: '0'.repeat(64) }), /manifest/);
  writeFileSync(join(directory, 'dist/index.js'), 'export const substituted = true;\n');
  assert.throws(() => verifyArchive(archive, expected, directory), /export/);

  const replacement = join(directory, 'replacement');
  mkdirSync(join(replacement, 'package'), { recursive: true });
  writeFileSync(join(replacement, 'package/package.json'), JSON.stringify({
    ...packageJson, publishConfig: { access: 'public', registry: 'https://attacker.invalid' },
  }));
  const malicious = join(directory, 'replacement.tgz');
  execFileSync('tar', ['-czf', malicious, '-C', replacement, 'package']);
  assert.throws(() => verifyArchive(malicious, expected), /publish configuration/);
});

test('publication requires independent review and an exact main branch policy', () => {
  const environment = {
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User' }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
  const rules = [{ type: 'pull_request', parameters: {
    required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true,
  } }];
  requireMainReviewRules(rules);
  assert.throws(() => requireMainReviewRules([]));
  assert.throws(() => requireMainReviewRules([{ ...rules[0], parameters: { ...rules[0].parameters, required_approving_review_count: 1 } }]));
  requireEnvironmentProtection(environment, policies);
  assert.throws(() => requireEnvironmentProtection({ ...environment, protection_rules: [] }, policies));
  assert.throws(() => requireEnvironmentProtection({ ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }] }, policies));
  for (const policy of [{ name: 'main', type: 'tag' }, { name: '*', type: 'branch' }]) {
    assert.throws(() => requireEnvironmentProtection(environment, { total_count: 1, branch_policies: [policy] }));
  }
  assert.throws(() => requireEnvironmentProtection(environment, { ...policies, total_count: 2 }));
});
