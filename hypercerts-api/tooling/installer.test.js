import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadAssets, orderAssets } from './installer.js';
import { validatePackageLexicons } from './validate-lexicons.js';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

async function loadBundle() {
  const { assets } = await loadAssets(manifestPath);
  return assets;
}

test('installer gives every declared query a handler that depends on its Lexicon', async () => {
  const assets = await loadBundle();
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const orderedIds = orderAssets(assets).map(({ id }) => id);
  const position = (id) => orderedIds.indexOf(id);
  const queries = assets.filter(({ kind, lexicon_json }) => kind === 'lexicon' && lexicon_json.defs?.main?.type === 'query');

  assert.ok(queries.length > 0, 'bundle must declare at least one query Lexicon');
  for (const query of queries) {
    const handlerId = `xrpc.query:${query.id}`;
    const handler = assetsById.get(handlerId);
    assert.ok(handler, `missing handler ${handlerId} for query ${query.id}`);
    assert.equal(handler.kind, 'script', `${handlerId} must be a script`);
    assert.ok(handler.dependsOn?.includes(query.id), `${handlerId} must depend on ${query.id}`);
    assert.ok(position(query.id) < position(handlerId), `${query.id} must install before ${handlerId}`);
  }
});

test('declared query schemas exist in the validation Lexicon set', async () => {
  const [assets, { lexicons, documents }] = await Promise.all([
    loadBundle(),
    validatePackageLexicons(),
  ]);
  const validatedDocuments = new Map(documents.map((document) => [document.id, document]));
  const queries = assets.filter(({ kind, lexicon_json }) => kind === 'lexicon' && lexicon_json.defs?.main?.type === 'query');

  for (const query of queries) {
    const document = validatedDocuments.get(query.id);
    assert.ok(document, `query schema ${query.id} is missing from validationLexicons`);
    assert.equal(document.id, query.id);
    assert.ok(lexicons.getDefOrThrow(query.id), `${query.id} must resolve in the validated Lexicon set`);
  }
});
