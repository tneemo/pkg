import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import semver from 'semver';

const pkg = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url)));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
assert.equal(pkg.name, '@tneemo/pkg');
assert.equal(pkg.mcpName, 'io.github.tneemo/pkg');
assert.equal(semver.valid(pkg.version), pkg.version);
assert.equal(server.name, pkg.mcpName);
assert.equal(server.version, pkg.version);
assert.equal(lock.packages.cli.version, pkg.version);
assert.deepEqual(pkg.bin, { pkg: 'dist/pkg.js', tpkg: 'dist/pkg.js' });
assert.equal(server.repository.url, 'https://github.com/tneemo/pkg');
assert.equal(pkg.repository.url, 'git+https://github.com/tneemo/pkg.git');
assert.equal(pkg.repository.directory, 'cli');
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(server.packages.length, 1);
const entry = server.packages[0];
assert.equal(entry.identifier, pkg.name);
assert.equal(entry.version, pkg.version);
assert.equal(entry.registryType, 'npm');
assert.equal(entry.registryBaseUrl, 'https://registry.npmjs.org');
assert.deepEqual(entry.transport, { type: 'stdio' });
assert.deepEqual(entry.packageArguments, [{ type: 'positional', value: 'mcp' }]);

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}

const npmUrl = `https://registry.npmjs.org/@tneemo%2fpkg/${pkg.version}`;
if (process.argv.includes('--release')) {
  assert.equal(process.env.RELEASE_VERSION, pkg.version, 'Approved version must match package.json');
  assert.equal(process.env.RELEASE_CONFIRMATION, `publish ${pkg.name}@${pkg.version}`, 'Explicit confirmation required');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', `refs/tags/v${pkg.version}^{commit}`), git('rev-parse', 'HEAD'), 'Release tag must point to the checked-out main commit');
  const response = await fetch(npmUrl, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 404, 'Version must not already exist; use Publish existing npm version to MCP for recovery');
}
if (process.argv.includes('--published')) {
  const published = await get(npmUrl);
  assert.equal(published.name, pkg.name);
  assert.equal(published.version, pkg.version);
  assert.equal(published.mcpName, server.name);
  assert.deepEqual(published.bin, pkg.bin);
  assert.equal(published.repository.url, pkg.repository.url);
}
if (process.argv.includes('--registry')) {
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
  const published = await get(url);
  assert.equal(published.server.name, server.name);
  assert.equal(published.server.version, server.version);
  assert.deepEqual(published.server.packages, server.packages);
  console.log(url);
}
console.log(`Distribution metadata verified: ${pkg.name}@${pkg.version}`);
