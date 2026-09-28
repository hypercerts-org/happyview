import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAssets } from './installer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => readFile(path.resolve(root, relative), 'utf8');
const manifestPath = path.join(root, 'manifest.json');

async function declaredLuaHandlers() {
  const bundle = JSON.parse(await read('manifest.json'));
  const { assets } = await loadAssets(manifestPath);
  const loadedById = new Map(assets.map((asset) => [asset.id, asset]));
  const handlers = [];

  for (const modulePath of bundle.modules) {
    const moduleFile = path.resolve(root, modulePath);
    const moduleManifest = JSON.parse(await readFile(moduleFile, 'utf8'));
    for (const declaration of moduleManifest.assets) {
      if (declaration.kind !== 'script' || declaration.config.script_type !== 'lua' || !declaration.id.startsWith('xrpc.query:')) continue;
      handlers.push({
        declaration,
        moduleDirectory: path.dirname(moduleFile),
        loaded: loadedById.get(declaration.id),
      });
    }
  }

  return { bundle, handlers };
}

function sourcePaths({ declaration, moduleDirectory }) {
  const shared = declaration.sharedSourcePaths ?? (declaration.sharedSourcePath ? [declaration.sharedSourcePath] : []);
  assert.ok(declaration.sourcePath, `${declaration.id} must declare its endpoint source`);
  return {
    endpoint: path.resolve(moduleDirectory, declaration.sourcePath),
    shared: shared.map((source) => path.resolve(moduleDirectory, source)),
  };
}

test('checked-in Lua bundles reproduce from declared handler sources', async () => {
  const { handlers } = await declaredLuaHandlers();
  assert.ok(handlers.length > 0, 'bundle must declare at least one Lua query handler');
  for (const handler of handlers) {
    const sources = sourcePaths(handler);
    const contents = await Promise.all([...sources.shared, sources.endpoint].map((file) => readFile(file, 'utf8')));
    const bundle = `${contents.map((source) => source.trimEnd()).join('\n\n')}\n`;
    const built = await readFile(path.resolve(handler.moduleDirectory, handler.declaration.path), 'utf8');
    assert.equal(built, bundle, `${handler.declaration.id} bundle is stale; run pnpm build:lua`);
    assert.match(built, /function handle\(\)/, `${handler.declaration.id} must define handle()`);
    assert.doesNotMatch(built, /\brequire\s*\(/, `${handler.declaration.id} must be standalone`);
  }
});

test('manifest installs declared Lua query handlers from their built bundles and sources', async () => {
  const { bundle, handlers } = await declaredLuaHandlers();
  assert.equal(bundle.authentication.unresolved, false);
  assert.ok(handlers.length > 0, 'bundle must declare at least one Lua query handler');

  for (const handler of handlers) {
    const { declaration, loaded } = handler;
    const name = declaration.id.slice('xrpc.query:'.length).split('.').at(-1);
    assert.ok(loaded, `missing loaded handler ${declaration.id}`);
    assert.equal(bundle.handlerStatus[name], 'implemented', `${name} must be marked implemented`);
    assert.equal(loaded.kind, 'script');
    assert.equal(loaded.path, declaration.path);
    assert.equal(loaded.sourcePath, declaration.sourcePath);
    const declaredShared = declaration.sharedSourcePaths ?? (declaration.sharedSourcePath ? [declaration.sharedSourcePath] : []);
    const loadedShared = loaded.sharedSourcePaths ?? (loaded.sharedSourcePath ? [loaded.sharedSourcePath] : []);
    assert.deepEqual(loadedShared, declaredShared);
    assert.match(loaded.body, /function handle\(\)/);
  }
});
