import test from 'node:test';
import assert from 'node:assert/strict';
import * as CID from '@atcute/cid';
import { locationRecords, profileRecords, organizationRecords, seedSql } from './records.js';

test('fixtures have consistent full AT-URIs, valid DID/TID/CID identifiers, types, and fixed timestamps', () => {
  const records = [...locationRecords, ...profileRecords, ...organizationRecords];
  for (const row of records) {
    assert.equal(row.uri, `at://${row.did}/${row.collection}/${row.rkey}`);
    assert.equal(row.record.$type, row.collection);
    const cid = CID.fromString(row.cid);
    assert.equal(cid.version, 1);
    assert.equal(cid.codec, 0x71);
    assert.equal(cid.digest.codec, 0x12);
    assert.equal(cid.digest.contents.length, 32);
    assert.equal(row.indexedAt, '2025-01-02T03:04:05.000Z');
  }
});

test('location fixtures cover the smallBlob union variant with a shaped blob reference', () => {
  const fixture = locationRecords.find(({ record }) => record.location?.$type === 'org.hypercerts.defs#smallBlob');
  assert.ok(fixture, 'expected a location fixture using the smallBlob union variant');
  assert.equal(fixture.cid, 'bafyreibttgrp2qdif53ifsfdzndmshje7aqjy6ybiddbu2pwgrwlwctxsm');
  assert.deepEqual(fixture.record.location.blob, {
    $type: 'blob',
    ref: { $link: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' },
    mimeType: 'application/geo+json',
    size: 68,
  });
});

test('fixture loader requires explicit disposable-target opt-in and parameterizes records only', () => {
  const records = [...locationRecords, ...profileRecords, ...organizationRecords];
  assert.throws(() => seedSql(records, {}), /explicit disposable-test target opt-in/);
  const statements = seedSql(records, { disposableTestTarget: true });
  assert.equal(statements.length, records.length);
  for (const { sql, params } of statements) {
    assert.match(sql, /INSERT INTO happyview_records/);
    assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP/i);
    assert.equal(params.length, 7);
    assert.doesNotMatch(sql, /\bat:\/\//);
  }
});

test('seedSql converts only supplied rows, including another collection', () => {
  const custom = {
    uri: 'at://did:web:custom.example/org.hypercerts.custom/item',
    did: 'did:web:custom.example', collection: 'org.hypercerts.custom', rkey: 'item',
    record: { $type: 'org.hypercerts.custom', name: 'Custom' },
    cid: 'bafycustom', indexedAt: '2025-01-02T03:04:05.000Z',
  };
  const statements = seedSql([custom], { disposableTestTarget: true });
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].params, [custom.uri, custom.did, custom.collection, custom.rkey, '{"$type":"org.hypercerts.custom","name":"Custom"}', custom.cid, custom.indexedAt]);
  assert.match(statements[0].sql, /INSERT INTO happyview_records/);
});
