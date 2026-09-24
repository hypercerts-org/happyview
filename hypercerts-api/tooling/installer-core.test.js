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
  assert.throws(() => orderAssets([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => orderAssets([{ id: 'a', dependsOn: ['missing'] }]), /Missing asset dependency/);
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

test('admin client rejects insecure remote targets before sending a request', () => {
  let called = false;
  assert.throws(() => createAdminClient({
    baseUrl: 'http://example.com', cookie: 'private',
    fetchImpl: async () => { called = true; },
  }), /HTTPS/);
  assert.equal(called, false);
});
