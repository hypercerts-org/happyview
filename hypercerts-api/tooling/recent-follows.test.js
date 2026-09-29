import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageLexicons } from './validate-lexicons.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

test('recent-follows registers both record schemas without owning the sibling entityFollow asset', async () => {
  const bundle = await readJson(path.join(root, 'manifest.json'));
  const recentModulePath = 'modules/recent-follows/manifest.json';
  assert.ok(bundle.modules.includes(recentModulePath), 'root bundle registers the recent-follows module');

  const recentModule = await readJson(path.join(root, recentModulePath));
  const query = recentModule.assets.find(({ id }) => id === 'app.certified.graph.listRecentFollows');
  assert.ok(query, 'recent-follows module owns its query Lexicon');
  assert.ok(query.dependsOn?.includes('app.certified.graph.follow'));
  assert.ok(query.dependsOn?.includes('app.certified.graph.entityFollow'));
  assert.equal(recentModule.assets.some(({ id }) => id === 'app.certified.graph.entityFollow'), false,
    'entityFollow remains owned by its sibling module');

  const validationIds = bundle.validationLexicons.map(({ id }) => id);
  assert.ok(validationIds.includes('app.certified.graph.follow'));
  assert.ok(validationIds.includes('app.certified.graph.entityFollow'));

  const moduleAssets = [];
  for (const modulePath of bundle.modules) {
    const manifest = await readJson(path.join(root, modulePath));
    moduleAssets.push(...manifest.assets.map((asset) => ({ ...asset, modulePath })));
  }
  assert.equal(moduleAssets.filter(({ id }) => id === 'app.certified.graph.entityFollow').length <= 1, true,
    'the sibling-owned entityFollow installed asset is not duplicated');
  assert.equal(moduleAssets.filter(({ id }) => id === 'app.certified.graph.follow').length, 1,
    'the existing account-follow installed asset has a single owner');

  const queryLexicon = await readJson(path.join(root, 'lexicons/app.certified.graph.listRecentFollows.json'));
  assert.deepEqual(
    queryLexicon.defs.recentFollowView.properties.record.refs.sort(),
    ['app.certified.graph.entityFollow', 'app.certified.graph.follow'],
  );
});

test('recentFollowView Lexicon validates indexedAt as nullable while retaining it as a required field', async () => {
  const { lexicons } = await validatePackageLexicons();
  const view = lexicons.getDefOrThrow('app.certified.graph.listRecentFollows#recentFollowView');
  assert.ok(view.required.includes('indexedAt'));
  assert.deepEqual(view.nullable, ['indexedAt']);
});
