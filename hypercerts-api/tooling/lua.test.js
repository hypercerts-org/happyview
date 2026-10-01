import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadAssets } from './installer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('checked-in Lua bundles reproduce from shared and endpoint sources', async () => {
  const [shared, getSource, listSource, getBeforeBuild, listBeforeBuild] = await Promise.all([
    read('lua/shared/location.lua'), read('lua/src/getLocation.lua'), read('lua/src/listLocations.lua'),
    readFile(new URL('../lua/endpoints/getLocation.lua', import.meta.url)),
    readFile(new URL('../lua/endpoints/listLocations.lua', import.meta.url)),
  ]);
  const expectedGet = Buffer.from(`${shared.trimEnd()}\n\n${getSource}`);
  const expectedList = Buffer.from(`${shared.trimEnd()}\n\n${listSource}`);
  assert.deepEqual(getBeforeBuild, expectedGet, 'getLocation bundle is stale; run pnpm build:lua');
  assert.deepEqual(listBeforeBuild, expectedList, 'listLocations bundle is stale; run pnpm build:lua');

  const result = spawnSync(process.execPath, ['tooling/build-lua.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [getBuilt, listBuilt] = await Promise.all([
    read('lua/endpoints/getLocation.lua'), read('lua/endpoints/listLocations.lua'),
  ]);
  assert.equal(getBuilt, `${shared.trimEnd()}\n\n${getSource}`);
  assert.equal(listBuilt, `${shared.trimEnd()}\n\n${listSource}`);
  assert.match(getBuilt, /local function get_location\(\)/);
  assert.doesNotMatch(getBuilt, /local function list_locations\(\)/);
  assert.match(listBuilt, /local function list_locations\(\)/);
  assert.doesNotMatch(listBuilt, /local function get_location\(\)/);
  assert.doesNotMatch(getBuilt, /\brequire\s*\(/);
  assert.doesNotMatch(listBuilt, /\brequire\s*\(/);
});

test('manifest installs only built standalone handlers and records their source inputs', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  assert.equal(manifest.handlerStatus.getLocation, 'implemented');
  assert.equal(manifest.handlerStatus.listLocations, 'implemented');
  assert.equal(manifest.authentication.unresolved, false);
  for (const name of ['getLocation', 'listLocations']) {
    const asset = assets.find(({ id }) => id === `xrpc.query:app.certified.location.${name}`);
    assert.equal(asset.kind, 'script');
    assert.equal(asset.path, `../../lua/endpoints/${name}.lua`);
    assert.equal(asset.sourcePath, `../../lua/src/${name}.lua`);
    assert.equal(asset.sharedSourcePath, '../../lua/shared/location.lua');
    assert.match(asset.body, /function handle\(\)/);
  }
});
