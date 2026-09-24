import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAssets, compareAsset, assertInstallable, createAdminClient, orderAssets, semanticJson } from './installer.js';

const asset = (kind, id, config, body) => ({ kind, id, config, body });

test('admin adapter refuses unsafe URLs before fetch without exposing credentials', async () => {
  for (const baseUrl of [
    'http://example.com', 'http://localhost.attacker.test', 'http://127.0.0.1.attacker.test',
    'file:///tmp/test', 'ftp://example.com', 'https://user:password@example.com',
  ]) {
    let calls = 0;
    assert.throws(() => createAdminClient({ baseUrl, cookie: 'session=private-secret', fetchImpl: async () => { calls++; } }), (error) => {
      assert.doesNotMatch(error.message, /private-secret|password|example\.com/);
      return true;
    }, baseUrl);
    assert.equal(calls, 0, baseUrl);
  }
});

test('admin adapter allows loopback HTTP including IPv6 and remote HTTPS', async () => {
  for (const baseUrl of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000', 'https://admin.example.com']) {
    let call;
    const client = createAdminClient({ baseUrl, cookie: 'session=private-secret', fetchImpl: async (url, init) => {
      call = { url: String(url), init };
      return new Response(null, { status: 404 });
    } });
    await client.read({ kind: 'lexicon', id: 'schema' });
    assert.ok(call, baseUrl);
  }
});

test('admin requests reject redirects and surface safe errors', async () => {
  const calls = [];
  const client = createAdminClient({ baseUrl: 'https://admin.example.com', cookie: 'session=private-secret', fetchImpl: async (url, init) => {
    calls.push(init);
    throw new Error('private-secret https://user:password@example.com');
  } });
  await assert.rejects(() => client.read({ kind: 'lexicon', id: 'schema' }), (error) => {
    assert.match(error.message, /request failed before receiving a response/);
    assert.doesNotMatch(error.message, /private-secret|password|example\.com/);
    return true;
  });
  assert.equal(calls[0].redirect, 'error');
});

test('admin HTTP adapter treats only GET 404 as missing and never leaks credentials in errors', async () => {
  const calls = [];
  let nextResponse = new Response(null, { status: 404 });
  const client = createAdminClient({
    baseUrl: 'http://127.0.0.1:8000', cookie: 'session=private-secret',
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return nextResponse; },
  });
  assert.equal(await client.read({ kind: 'lexicon', id: 'app.example.schema' }), null);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.cookie, 'session=private-secret');
  await assert.rejects(() => client.write({ kind: 'lexicon', id: 'app.example.schema', lexicon_json: {}, config: {} }), (error) => {
    assert.match(error.message, /POST .*HTTP 404/);
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
  assert.equal(calls[1].init.method, 'POST');
  nextResponse = new Response('private-secret internal detail', { status: 500 });
  await assert.rejects(() => client.read({ kind: 'lexicon', id: 'app.example.schema' }), (error) => {
    assert.match(error.message, /GET .*HTTP 500/);
    assert.doesNotMatch(error.message, /private-secret|internal detail/);
    return true;
  });
});

test('installer asset manifest includes every validated record and hydration Lexicon with backfill disabled', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const installed = new Map(manifest.assets.filter(({ kind }) => kind === 'lexicon').map((entry) => [entry.id, entry]));
  for (const source of manifest.validationLexicons) {
    const asset = installed.get(source.id);
    assert.ok(asset, `missing install asset ${source.id}`);
    assert.equal(asset.config.backfill, false, `${source.id} must not backfill during install`);
    assert.equal(asset.path, source.path);
    assert.equal(asset.packagePath, source.packagePath);
  }
  const ordered = orderAssets(manifest.assets).map(({ id }) => id);
  const definitions = ordered.indexOf('app.certified.location.defs');
  const query = ordered.indexOf('app.certified.location.getLocation');
  const script = ordered.indexOf('xrpc.query:app.certified.location.getLocation');
  assert.ok(definitions > 0 && query > definitions && script > query);
  const schemaGroup = manifest.assets.filter(({ registrationGroup }) => registrationGroup === 'location-record-schema-sources').map(({ id }) => id);
  assert.ok(schemaGroup.length > 0);
  assert.ok(schemaGroup.every((id) => ordered.indexOf(id) < definitions));
});

test('the local location API schemas remain the only checked-in schemas', () => {
  const files = readdirSync(new URL('../lexicons/', import.meta.url)).filter((file) => file.endsWith('.json'));
  assert.deepEqual(files.sort(), [
    'app.certified.location.defs.json',
    'app.certified.location.getLocation.json',
    'app.certified.location.listLocations.json',
  ]);
});

test('semantic JSON/config equality ignores object key order but Lua body stays exact', () => {
  assert.equal(compareAsset(asset('lexicon', 'one', { a: 1, b: { c: 2 } }), { config: { b: { c: 2 }, a: 1 } }), 'unchanged');
  assert.equal(compareAsset(asset('script', 'two', {}, 'return 1\n'), { config: {}, body: 'return 1' }), 'conflict');
});

test('semantic JSON sorts nested keys by UTF-16 code units rather than locale collation', () => {
  const input = {
    '\uE000': { a: 1, Z: 2 },
    '\u{10000}': { '\uE000': 1, '\u{10000}': 2 },
    é: 3,
    a: 4,
    Z: 5,
  };
  assert.equal(
    JSON.stringify(semanticJson(input)),
    '{"Z":5,"a":4,"é":3,"\u{10000}":{"\u{10000}":2,"\uE000":1},"\uE000":{"Z":2,"a":1}}',
  );
});

test('nested lexicon key reordering is unchanged, but changed nested values conflict', () => {
  const item = {
    kind: 'lexicon', id: 'schema', config: { options: { Z: true, a: false } },
    lexicon_json: { defs: { main: { type: 'record', fields: { Z: 'upper', a: 'lower' } } } },
  };
  const installed = {
    config: { options: { a: false, Z: true } },
    lexicon_json: { defs: { main: { fields: { a: 'lower', Z: 'upper' }, type: 'record' } } },
  };
  assert.equal(compareAsset(item, installed), 'unchanged');
  assert.equal(compareAsset(item, { ...installed, lexicon_json: { defs: { main: { fields: { a: 'changed', Z: 'upper' }, type: 'record' } } } }), 'conflict');
});

test('apply skips unchanged and creates in declared dependency order', async () => {
  const assets = [asset('script', 'xrpc.query:app.certified.location.getLocation', {}, 'body'), asset('lexicon', 'app.certified.location.getLocation', { backfill: false }, undefined)];
  const calls = [];
  const client = {
    read: async (item) => item.kind === 'lexicon' ? null : null,
    write: async (item) => calls.push(item.id),
  };
  const result = await applyAssets(assets, client);
  assert.deepEqual(calls, ['app.certified.location.getLocation', 'xrpc.query:app.certified.location.getLocation']);
  assert.equal(result.changed.length, 2);
});

test('unchanged installed assets are skipped without writes', async () => {
  let writes = 0;
  const item = { ...asset('lexicon', 'same', { backfill: false, options: { Z: true, a: false } }), lexicon_json: { lexicon: 1, id: 'same', defs: { main: { Z: 1, a: 2 } } } };
  const result = await applyAssets([item], {
    read: async () => ({ config: { options: { a: false, Z: true }, backfill: false }, lexicon_json: { defs: { main: { a: 2, Z: 1 } }, id: 'same', lexicon: 1 } }),
    write: async () => { writes++; },
  });
  assert.equal(writes, 0);
  assert.deepEqual(result, { changed: [], unchanged: ['same'] });
});

test('conflict refusal performs no writes', async () => {
  let writes = 0;
  await assert.rejects(() => applyAssets([asset('lexicon', 'schema', { backfill: false })], {
    read: async () => ({ config: { backfill: true } }),
    write: async () => { writes++; },
  }), /unexpected installed difference/);
  assert.equal(writes, 0);
});

test('incomplete location package cannot be applied even when explicitly forced', () => {
  assert.throws(() => assertInstallable({ handlerStatus: { getLocation: 'pending', listLocations: 'pending' } }), /real Lua handlers/);
  assert.throws(() => assertInstallable({ handlerStatus: {} }), /getLocation, listLocations/);
});

test('complete checked-in location package passes installer handler preflight', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => assertInstallable(manifest, root));
});

test('preflight requires both exact script assets and nonempty source files after status approval', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = {
    handlerStatus: { getLocation: 'implemented', listLocations: 'implemented' },
    assets: [
      { kind: 'script', id: 'xrpc.query:app.certified.location.getLocation', path: 'README.md' },
      { kind: 'script', id: 'xrpc.query:app.certified.location.listLocations', path: 'README.md' },
    ],
  };
  assert.doesNotThrow(() => assertInstallable(manifest, root));
  manifest.assets.pop();
  assert.throws(() => assertInstallable(manifest, root), /source is missing.*listLocations/);
  manifest.assets.push({ kind: 'script', id: 'xrpc.query:app.certified.location.listLocations', path: 'missing.lua' });
  assert.throws(() => assertInstallable(manifest, root), /source is missing.*listLocations/);
});

test('partial failure reports completed and remaining asset IDs', async () => {
  const assets = [asset('lexicon', 'first', {}), asset('lexicon', 'second', {})];
  let writes = 0;
  await assert.rejects(() => applyAssets(assets, {
    read: async () => null,
    write: async () => { if (++writes === 2) throw new Error('offline'); },
  }), (error) => {
    assert.match(error.message, /offline/);
    assert.deepEqual(error.completed, ['first']);
    assert.deepEqual(error.remaining, ['second']);
    return true;
  });
});
