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
  assert.throws(() => seedSql({}), /explicit disposable-test target opt-in/);
  const statements = seedSql({ disposableTestTarget: true });
  assert.ok(statements.length > 0);
  for (const { sql, params } of statements) {
    assert.match(sql, /INSERT INTO happyview_records/);
    assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP/i);
    assert.equal(params.length, 7);
    assert.doesNotMatch(sql, /\bat:\/\//);
  }
});
