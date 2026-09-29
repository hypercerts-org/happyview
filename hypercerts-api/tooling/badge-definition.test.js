import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isValidLexiconDoc, Lexicons } from '@atproto/lexicon';
import { orderAssets } from './installer.js';
import { readLexiconSource } from './lexicon-source.js';
import { validatePackageLexicons } from './validate-lexicons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const badgeModulePath = 'modules/badge-definitions/manifest.json';
const locationModulePath = 'modules/location/manifest.json';

async function readJson(relativePath) {
  return JSON.parse(await readFile(`${root}/${relativePath}`, 'utf8'));
}

function checkRefs(value, lexicons) {
  if (Array.isArray(value)) {
    value.forEach((item) => checkRefs(item, lexicons));
  } else if (value && typeof value === 'object') {
    if (value.type === 'ref') lexicons.getDefOrThrow(value.ref);
    if (value.type === 'union') value.refs.forEach((ref) => lexicons.getDefOrThrow(ref));
    Object.values(value).forEach((item) => checkRefs(item, lexicons));
  }
}

test('badge-definition module closes package and view Lexicon refs with the location-owned signature schema', async () => {
  const [badgeModule, locationModule, { documents: packageDocuments }] = await Promise.all([
    readJson(badgeModulePath),
    readJson(locationModulePath),
    validatePackageLexicons(root),
  ]);
  const badgeAssets = badgeModule.assets;
  const locationAssets = locationModule.assets;
  const recordAsset = badgeAssets.find(({ id }) => id === 'app.certified.badge.definition');
  assert.equal(recordAsset.packagePath, 'lexicons/app/certified/badge/definition.json');
  assert.equal(badgeAssets.filter(({ id }) => id === 'app.certified.badge.definition').length, 1);
  assert.deepEqual(recordAsset.dependsOn, ['app.certified.defs', 'app.certified.signature.defs']);
  assert.equal(locationAssets.filter(({ id }) => id === 'app.certified.signature.defs').length, 1);

  const selectedAssets = [...locationAssets, ...badgeAssets];
  const orderedAssets = orderAssets(selectedAssets);
  const assetIndex = (id) => orderedAssets.findIndex((asset) => asset.id === id);
  assert.ok(assetIndex('app.certified.signature.defs') < assetIndex('app.certified.badge.definition'));
  assert.equal(selectedAssets.filter(({ id }) => id === 'app.certified.badge.definition').length, 1);

  const badgeLexicons = await Promise.all(badgeAssets
    .filter(({ kind }) => kind === 'lexicon')
    .map((asset) => readLexiconSource(asset, `${root}/modules/badge-definitions`)));
  for (const document of badgeLexicons) {
    assert.ok(isValidLexiconDoc(document), `invalid Lexicon ${document.id}`);
  }
  const lexicons = new Lexicons([...packageDocuments, ...badgeLexicons]);
  for (const document of badgeLexicons) checkRefs(document, lexicons);

  const badgeDefinitionView = lexicons.getDefOrThrow('app.certified.badge.getBadgeDefinition#badgeDefinitionView');
  const listOutput = lexicons.getDefOrThrow('app.certified.badge.listBadgeDefinitions#output');
  assert.equal(badgeDefinitionView.properties.record.ref, 'lex:app.certified.badge.definition');
  assert.equal(listOutput.properties.badgeDefinitions.items.ref,
    'lex:app.certified.badge.getBadgeDefinition#badgeDefinitionView');
});
