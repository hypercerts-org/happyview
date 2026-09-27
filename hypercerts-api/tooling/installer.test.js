import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAssets, orderAssets } from './installer.js';

test('installer deploys only location records, required definitions, API Lexicons, and handlers', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  const installed = new Map(assets.filter(({ kind }) => kind === 'lexicon').map((entry) => [entry.id, entry]));
  const expectedAssetIds = [
    'app.certified.actor.organization',
    'app.certified.actor.profile',
    'app.certified.location',
    'app.certified.signature.defs',
    'org.hypercerts.defs',
    'org.hypercerts.api.defs',
    'app.certified.location.getLocation',
    'app.certified.location.listLocations',
    'xrpc.query:app.certified.location.getLocation',
    'xrpc.query:app.certified.location.listLocations',
  ];
  assert.deepEqual(assets.map(({ id }) => id).sort(), expectedAssetIds.sort());

  const backfilledCollections = new Set([
    'app.certified.actor.organization',
    'app.certified.actor.profile',
    'app.certified.location',
  ]);
  const validationSources = new Map(manifest.validationLexicons.map((source) => [source.id, source]));
  for (const asset of installed.values()) {
    assert.equal(asset.config.backfill, backfilledCollections.has(asset.id), `${asset.id} backfill configuration`);
    assert.equal(asset.lexicon_json.id, asset.id);
    if (asset.packagePath) assert.equal(asset.packagePath, validationSources.get(asset.id)?.packagePath);
  }
  const ordered = orderAssets(assets).map(({ id }) => id);
  const position = (id) => ordered.indexOf(id);
  const sharedViews = installed.get('org.hypercerts.api.defs');
  const locationRecord = installed.get('app.certified.location');
  const getLocation = installed.get('app.certified.location.getLocation');
  const listLocations = installed.get('app.certified.location.listLocations');
  assert.ok(sharedViews, 'missing shared API view definitions');
  assert.ok(locationRecord, 'missing pinned location record schema');
  assert.ok(getLocation, 'missing getLocation Lexicon');
  assert.ok(listLocations, 'missing listLocations Lexicon');
  assert.deepEqual(sharedViews.dependsOn, ['app.certified.actor.organization', 'app.certified.actor.profile']);
  assert.deepEqual(getLocation.dependsOn, ['app.certified.location', 'org.hypercerts.api.defs']);
  assert.deepEqual(listLocations.dependsOn, ['app.certified.location.getLocation']);
  assert.equal(locationRecord.packagePath, 'lexicons/app/certified/location.json');
  assert.ok(position('app.certified.actor.organization') < position('org.hypercerts.api.defs'));
  assert.ok(position('app.certified.actor.profile') < position('org.hypercerts.api.defs'));
  assert.ok(position('app.certified.location') < position('app.certified.location.getLocation'));
  assert.ok(position('org.hypercerts.api.defs') < position('app.certified.location.getLocation'));
  assert.ok(position('app.certified.location.getLocation') < position('app.certified.location.listLocations'));
  assert.ok(position('app.certified.location.getLocation') < position('xrpc.query:app.certified.location.getLocation'));
  assert.ok(position('app.certified.location.listLocations') < position('xrpc.query:app.certified.location.listLocations'));
});

test('the local location API schemas remain the only checked-in schemas', () => {
  const files = readdirSync(new URL('../lexicons/', import.meta.url)).filter((file) => file.endsWith('.json'));
  assert.deepEqual(files.sort(), [
    'app.certified.location.getLocation.json',
    'app.certified.location.listLocations.json',
    'org.hypercerts.api.defs.json',
  ]);
});
