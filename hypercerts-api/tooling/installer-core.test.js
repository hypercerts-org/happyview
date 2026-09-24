import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAssets, createAdminClient, orderAssets } from './installer.js';

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

test('admin client never forwards cookies across redirects and rejects URL credentials', async () => {
  const calls = [];
  const admin = createAdminClient({ baseUrl: 'http://localhost:8080', cookie: 'secret', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    throw new Error('redirect disallowed');
  } });
  await assert.rejects(() => admin.read({ id: 'x', kind: 'script' }), /request failed before receiving a response/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.cookie, 'secret');
  assert.throws(() => createAdminClient({ baseUrl: 'https://user:password@example.com', cookie: 'secret' }), /no URL credentials/);
});

test('admin client rejects insecure remote targets before sending a request', () => {
  let called = false;
  assert.throws(() => createAdminClient({
    baseUrl: 'http://example.com', cookie: 'private',
    fetchImpl: async () => { called = true; },
  }), /HTTPS/);
  assert.equal(called, false);
});

test('admin client preserves action and token_cost when writing lexicons', async () => {
  const calls = [];
  const admin = createAdminClient({
    baseUrl: 'http://localhost:8080',
    cookie: 'session=secret',
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
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    lexicon_json: { lexicon: 1, id: 'org.example.record' },
    backfill: true,
    target_collection: 'org.example.record',
    action: 'create',
    token_cost: 7,
  });
});
