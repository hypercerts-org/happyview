import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { applyAssets, compareAsset, createAdminClient, orderAssets, sortJsonKeys } from './installer.js';

test('installer orders dependencies before consumers regardless of manifest order', () => {
  const assets = [
    { id: 'script', kind: 'script', dependsOn: ['query'] },
    { id: 'query', kind: 'lexicon', dependsOn: ['record'] },
    { id: 'record', kind: 'lexicon' },
  ];
  assert.deepEqual(orderAssets(assets).map(({ id }) => id), ['record', 'query', 'script']);
  assert.throws(() => orderAssets([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle.*remove.*dependsOn/i);
  assert.throws(() => orderAssets([{ id: 'a', dependsOn: ['missing'] }]), /Missing asset dependency.*add.*bundle/i);
});

test('installer preflights every asset before writing and refuses conflicts', async () => {
  const written = [];
  await assert.rejects(() => applyAssets([
    { id: 'first', kind: 'lexicon', config: { backfill: false } },
    { id: 'second', kind: 'lexicon', config: { backfill: false } },
  ], {
    read: async ({ id }) => id === 'first' ? null : { config: { backfill: true } },
    write: async ({ id }) => written.push(id),
  }), /unexpected installed difference/);
  assert.deepEqual(written, []);
});

test('unchanged assets are skipped and partial failures report completed and remaining writes', async () => {
  const assets = [
    { id: 'existing', kind: 'script', config: {}, body: 'return true' },
    { id: 'new', kind: 'script', config: {}, body: 'return true' },
    { id: 'failed', kind: 'script', config: {}, body: 'return true' },
    { id: 'later', kind: 'script', config: {}, body: 'return true' },
  ];
  const written = [];
  await assert.rejects(() => applyAssets(assets, {
    read: async ({ id }) => id === 'existing' ? { config: {}, body: 'return true' } : null,
    write: async ({ id }) => { if (id === 'failed') throw new Error('disk full'); written.push(id); },
  }), (error) => {
    assert.deepEqual(error.completed, ['new']);
    assert.deepEqual(error.remaining, ['failed', 'later']);
    return /disk full/.test(error.message);
  });
  assert.deepEqual(written, ['new']);
});

test('apply reports an all-unchanged result without writing', async () => {
  const asset = { id: 'same', kind: 'script', config: {}, body: 'return true' };
  let writes = 0;
  const result = await applyAssets([asset], {
    read: async () => ({ config: {}, body: 'return true' }),
    write: async () => { writes++; },
  });
  assert.equal(writes, 0);
  assert.deepEqual(result, { changed: [], unchanged: ['same'] });
});

test('admin client requires a nonblank bearer token and rejects cookie-only auth', () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const token of [undefined, '', ' \t']) {
    assert.throws(() => createAdminClient({
      baseUrl: 'http://localhost:8080', token, cookie: 'session=secret', fetchImpl,
    }), /HAPPYVIEW_ADMIN_TOKEN.*README/);
  }
  assert.throws(() => createAdminClient({
    baseUrl: 'http://localhost:8080', cookie: 'session=secret', fetchImpl,
  }), /HAPPYVIEW_ADMIN_TOKEN.*README/);
  assert.equal(called, false);
});

test('admin client sanitizes request failures that contain the bearer token', async () => {
  const token = 'hv_do-not-leak';
  const admin = createAdminClient({
    baseUrl: 'http://localhost:8080', token,
    fetchImpl: async () => { throw new Error(`request failed for ${token}`); },
  });
  await assert.rejects(() => admin.read({ id: 'x', kind: 'script' }), (error) => {
    assert.match(error.message, /request failed before receiving a response/);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});

test('admin client rejects redirects before forwarding the bearer token', async (t) => {
  const token = 'hv_redirect-secret';
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    if (request.url === '/admin/scripts/x') {
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    } else {
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();
  const admin = createAdminClient({ baseUrl: `http://127.0.0.1:${port}`, token });

  await assert.rejects(() => admin.read({ id: 'x', kind: 'script' }), /request failed before receiving a response/);
  assert.deepEqual(paths, ['/admin/scripts/x']);
});

test('admin client rejects unsafe URLs before sending a request or exposing URL details', () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const baseUrl of [
    'http://example.com', 'http://localhost.attacker.test', 'http://127.0.0.1.attacker.test',
    'file:///tmp/test', 'ftp://example.com', 'https://user:password@example.com',
  ]) {
    assert.throws(() => createAdminClient({ baseUrl, token: 'hv_private-secret', fetchImpl }), (error) => {
      assert.doesNotMatch(error.message, /private-secret|password|example\.com/);
      return true;
    }, baseUrl);
  }
  assert.equal(called, false);
});

test('admin client accepts loopback HTTP and HTTPS targets', async () => {
  for (const baseUrl of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000', 'https://admin.example.com']) {
    let called = false;
    const admin = createAdminClient({
      baseUrl, token: 'hv_loopback-test-token',
      fetchImpl: async () => { called = true; return new Response(null, { status: 404 }); },
    });
    assert.equal(await admin.read({ id: 'schema', kind: 'lexicon' }), null);
    assert.equal(called, true, baseUrl);
  }
});

test('admin client treats only GET 404 as missing and sanitizes HTTP errors', async () => {
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
    new Response('hv_http-test-secret internal detail', { status: 500 }),
  ];
  const calls = [];
  const admin = createAdminClient({
    baseUrl: 'http://127.0.0.1:8000', token: 'hv_http-test-secret',
    fetchImpl: async (_url, init) => { calls.push(init); return responses.shift(); },
  });
  assert.equal(await admin.read({ id: 'schema', kind: 'lexicon' }), null);
  await assert.rejects(() => admin.write({ id: 'schema', kind: 'lexicon', config: {}, lexicon_json: {} }), /POST .*HTTP 404/);
  await assert.rejects(() => admin.read({ id: 'schema', kind: 'lexicon' }), (error) => {
    assert.match(error.message, /GET .*HTTP 500/);
    assert.doesNotMatch(error.message, /hv_http-test-secret|internal detail/);
    return true;
  });
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST', 'GET']);
});

test('semantic JSON comparison ignores nested key order but rejects changed values and script bodies', () => {
  const item = {
    id: 'schema', kind: 'lexicon', config: { options: { Z: true, a: false } },
    lexicon_json: { defs: { main: { type: 'record', fields: { Z: 'upper', a: 'lower' } } } },
  };
  const installed = {
    config: { options: { a: false, Z: true } },
    lexicon_json: { defs: { main: { fields: { a: 'lower', Z: 'upper' }, type: 'record' } } },
  };
  assert.equal(compareAsset(item, installed), 'unchanged');
  assert.equal(compareAsset(item, { ...installed, lexicon_json: { defs: { main: { fields: { a: 'changed', Z: 'upper' }, type: 'record' } } } }), 'conflict');
  assert.equal(compareAsset({ id: 'script', kind: 'script', config: {}, body: 'return true\n' }, { config: {}, body: 'return true' }), 'conflict');
});

test('asset comparison ignores server defaults for undeclared config keys', () => {
  const asset = { id: 'script', kind: 'script', config: {}, body: 'return true' };
  assert.equal(compareAsset(asset, { config: { script_type: 'lua' }, body: 'return true' }), 'unchanged');

  const configured = { ...asset, config: { description: 'custom' } };
  assert.equal(compareAsset(configured, { config: { script_type: 'lua', description: 'custom' }, body: 'return true' }), 'unchanged');
  assert.equal(compareAsset(configured, { config: { script_type: 'lua', description: 'different' }, body: 'return true' }), 'conflict');
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
    JSON.stringify(sortJsonKeys(input)),
    '{"Z":5,"a":4,"é":3,"\u{10000}":{"\u{10000}":2,"\uE000":1},"\uE000":{"Z":2,"a":1}}',
  );
});

test('admin client preserves action and token_cost when writing lexicons', async () => {
  const calls = [];
  const admin = createAdminClient({
    baseUrl: 'http://localhost:8080',
    token: 'hv_write-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await admin.write({
    id: 'org.example.record',
    kind: 'lexicon',
    config: { backfill: true, target_collection: 'org.example.record', action: 'create', token_cost: 7 },
    lexicon_json: { lexicon: 1, id: 'org.example.record' },
  });
  assert.equal(calls[0].url, 'http://localhost:8080/admin/lexicons');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer hv_write-secret');
  assert.equal('cookie' in calls[0].options.headers, false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    lexicon_json: { lexicon: 1, id: 'org.example.record' },
    backfill: true,
    target_collection: 'org.example.record',
    action: 'create',
    token_cost: 7,
  });
});
