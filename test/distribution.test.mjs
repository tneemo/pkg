import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url)));
const run = (args = [], env = {}) => spawnSync(process.execPath, ['scripts/check-distribution.mjs', ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ...env }
});

test('distribution metadata keeps npm, MCP, lockfile and both CLI aliases consistent', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('release guard refuses an unconfirmed publication before accessing the network', () => {
  const result = run(['--release'], { RELEASE_VERSION: version, RELEASE_CONFIRMATION: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Explicit confirmation required/);
});

test('release guard refuses an approval for a different version', () => {
  const result = run(['--release'], { RELEASE_VERSION: '999.0.0', RELEASE_CONFIRMATION: 'publish @tneemo/pkg@999.0.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Approved version must match package.json/);
});
