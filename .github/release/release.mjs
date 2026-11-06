import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const PACKAGE = '@gauntlet-xyz/sdk';
export const NPM_VERSION = '11.6.0';
export const NPM_INTEGRITY = 'sha512-d/P7DbvYgYNde9Ehfeq99+13/E7E82PfZPw8uYZASr9sQ3ZhBBCA9cXSJRA1COfJ6jDLJ0K36UJnXQWhCvLXuQ==';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const member = (archive, path) => execFileSync('tar', ['-xOf', archive, `package/${path}`], { maxBuffer: 16 * 1024 * 1024 });

export function requireNewStableVersion(version, previous) {
  assert.match(version, STABLE_VERSION, 'Live releases require a stable semantic version');
  assert.match(previous, STABLE_VERSION, 'The previous release must have a stable semantic version');
  const next = version.split('.').map(BigInt);
  const before = previous.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > before[index]) return;
    if (next[index] < before[index]) break;
  }
  throw new Error('The release version must increase');
}

export function requireTag(tag) {
  assert.match(tag, /^[a-z][a-z0-9-]{0,63}$/, 'The dist-tag must contain only lowercase letters, digits, and hyphens');
  return tag;
}

export function requirePackage(pkg) {
  assert.equal(pkg.name, PACKAGE, 'The package name must match the trusted publisher');
  assert(pkg.private === undefined || pkg.private === false, 'The release package must be public');
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/, 'Invalid package version');
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: REGISTRY }, 'Unexpected publish configuration');
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    assert(!/[\r\n]/.test(String(value)), 'Job output values must occupy one line');
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

export function prepare(env) {
  const selected = env.EVENT_NAME === 'workflow_dispatch' && env.REQUESTED_REF ? env.REQUESTED_REF : env.SOURCE_SHA;
  assert(selected && !/[\r\n]/.test(selected), 'The source ref must occupy one line');
  const sha = git('rev-parse', '--verify', '--end-of-options', `${selected}^{commit}`);
  assert.match(sha, SHA);
  const pkg = JSON.parse(git('show', `${sha}:package.json`));
  requirePackage(pkg);
  const tag = requireTag(env.DIST_TAG || 'latest');
  let publish = false;
  if (env.EVENT_NAME === 'push') {
    assert.equal(env.SOURCE_REF, 'refs/heads/main');
    assert.equal(sha, env.SOURCE_SHA);
    assert.match(env.BEFORE_SHA, SHA);
    const previous = JSON.parse(git('show', `${env.BEFORE_SHA}:package.json`)).version;
    if (pkg.version !== previous) {
      requireNewStableVersion(pkg.version, previous);
      assert.equal(tag, 'latest');
      publish = true;
    }
  }
  const manifest = execFileSync('git', ['show', `${sha}:manifest/vaults.json`]);
  return {
    source_sha: sha, package_version: pkg.version, manifest_sha256: digest(manifest),
    dist_tag: tag, publish: String(publish),
  };
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  assert(value && typeof value === 'object', 'Invalid package exports');
  return Object.values(value).flatMap(exportTargets);
}

export function verifyArchive(archive, expected, sourceDirectory) {
  if (expected.sha256 !== undefined) {
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
    assert.equal(digest(readFileSync(archive)), expected.sha256, 'The release artifact digest changed');
  }
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(new Set(entries).size, entries.length, 'The archive has duplicate members');
  for (const entry of entries) {
    assert(entry.startsWith('package/') && !entry.split('/').includes('..'), 'Invalid archive member path');
  }
  const pkg = JSON.parse(member(archive, 'package.json'));
  requirePackage(pkg);
  assert.equal(pkg.version, expected.version, 'The packed version differs from the selected commit');
  for (const path of ['manifest/vaults.json', 'dist/manifest/vaults.json']) {
    assert.equal(digest(member(archive, path)), expected.manifest, 'The packed manifest differs from the selected commit');
  }
  for (const target of exportTargets(pkg.exports)) {
    assert.match(target, /^\.\/dist\/[A-Za-z0-9_./-]+$/);
    assert(!target.split('/').includes('..'));
    const bytes = member(archive, target.slice(2));
    assert(bytes.length > 0, 'The packed export is empty');
    if (sourceDirectory !== undefined) {
      assert.equal(digest(bytes), digest(readFileSync(join(sourceDirectory, target))), 'The packed export differs from the build');
    }
  }
  return digest(readFileSync(archive));
}

export function requireEnvironmentProtection(environment, policies) {
  const reviewers = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  assert(reviewers?.reviewers?.length > 0, 'npm-publish needs required reviewers');
  assert.equal(reviewers.prevent_self_review, true, 'npm-publish must prevent self-review');
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, 'npm-publish needs an explicit branch policy');
  assert.equal(environment.deployment_branch_policy?.protected_branches, false);
  assert.equal(policies.total_count, 1, 'npm-publish must allow only the main branch');
  assert.equal(policies.branch_policies[0]?.name, 'main');
  assert.equal(policies.branch_policies[0]?.type, 'branch');
}

export function requireMainReviewRules(rules) {
  const reviews = rules.filter((rule) => rule.type === 'pull_request').map((rule) => rule.parameters);
  assert(reviews.some((review) => review.required_approving_review_count >= 1), 'Main needs at least one pull request approval');
  assert(reviews.some((review) => review.require_code_owner_review === true), 'Main must require code owner review');
  assert(reviews.some((review) => review.dismiss_stale_reviews_on_push === true), 'Main must dismiss stale approvals');
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/Gauntlet-xyz/sdk/${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  assert(response.ok, `GitHub policy read failed for ${path}: ${response.status}`);
  return response.json();
}

async function bootstrapNpm() {
  const response = await fetch(`${REGISTRY}/npm/-/npm-${NPM_VERSION}.tgz`);
  assert(response.ok, `npm download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, NPM_INTEGRITY, 'The npm CLI archive integrity changed');
  const archive = join(process.env.RUNNER_TEMP, `npm-${NPM_VERSION}.tgz`);
  writeFileSync(archive, bytes);
  process.stdout.write(npm('install', '--global', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', REGISTRY));
  assert.equal(npm('--version').trim(), NPM_VERSION);
}

async function main(command) {
  if (command === 'prepare') {
    output(prepare(process.env));
  } else if (command === 'bootstrap-npm') {
    await bootstrapNpm();
  } else if (command === 'pack') {
    const tag = requireTag(process.env.DIST_TAG);
    mkdirSync('release-artifact', { recursive: true });
    const [packed] = JSON.parse(npm('pack', '--json', '--ignore-scripts', '--pack-destination', 'release-artifact'));
    assert.equal(packed.filename, basename(packed.filename));
    const archive = resolve('release-artifact/sdk.tgz');
    renameSync(join('release-artifact', packed.filename), archive);
    const sha256 = verifyArchive(archive, {
      version: process.env.PACKAGE_VERSION, manifest: process.env.MANIFEST_SHA256,
    }, process.cwd());
    const published = await fetch(`${REGISTRY}/@gauntlet-xyz%2Fsdk/${process.env.PACKAGE_VERSION}`);
    if (published.status === 200) {
      assert.notEqual(process.env.PUBLISH, 'true', 'The release version is already published');
      console.log('The version is already published. Archive validation passed; publication is not eligible.');
    } else {
      assert.equal(published.status, 404, 'The registry version check failed');
      process.stdout.write(npm('publish', archive, '--dry-run', '--ignore-scripts', '--registry', REGISTRY,
        '--access', 'public', '--tag', tag, '--loglevel=error'));
    }
    output({ sha256 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      assert.match(process.env.RELEASE_SHA, SHA);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '## SDK release validation', '',
        `- Source commit: \`${process.env.RELEASE_SHA}\``,
        `- Package: \`${PACKAGE}@${process.env.PACKAGE_VERSION}\``,
        `- Archive SHA-256: \`${sha256}\``,
        `- Manifest SHA-256: \`${process.env.MANIFEST_SHA256}\``,
        `- Dist-tag: \`${tag}\``,
        `- Publication requested: \`${process.env.PUBLISH}\``, '',
      ].join('\n'));
    }
  } else if (command === 'verify-release') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    assert.equal(process.env.GITHUB_REPOSITORY, 'Gauntlet-xyz/sdk');
    assert.match(process.env.RELEASE_SHA, SHA);
    assert.equal(process.env.RELEASE_SHA, process.env.GITHUB_SHA);
    const [environment, policies, rules] = await Promise.all([
      github('environments/npm-publish'), github('environments/npm-publish/deployment-branch-policies?per_page=100'),
      github('rules/branches/main'),
    ]);
    requireEnvironmentProtection(environment, policies);
    requireMainReviewRules(rules);
    assert.match(process.env.BEFORE_SHA, SHA);
    const before = JSON.parse(git('show', `${process.env.BEFORE_SHA}:package.json`)).version;
    requireNewStableVersion(process.env.PACKAGE_VERSION, before);
    verifyArchive(resolve('release-artifact/sdk.tgz'), {
      version: process.env.PACKAGE_VERSION, manifest: process.env.MANIFEST_SHA256, sha256: process.env.ARTIFACT_SHA256,
    });
  } else if (command === 'verify-registry') {
    const latest = JSON.parse(npm('view', PACKAGE, 'dist-tags.latest', '--json', '--registry', REGISTRY));
    requireNewStableVersion(process.env.PACKAGE_VERSION, latest);
  } else {
    throw new Error(`Unknown release command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2]);
}
