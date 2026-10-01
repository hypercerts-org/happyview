import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { isValidDid, isValidTid } from '@atproto/syntax';
import { locationRecords, profileRecords, organizationRecords, seedSql } from './records.js';
import {
  actorFollowDids,
  actorFollowOrganizationRecords,
  actorFollowProfileRecords,
  actorFollowRecords,
} from './actor-follows.js';

test('fixtures have consistent full AT-URIs, valid DID/TID/CID identifiers, types, and fixed timestamps', () => {
  const records = [
    ...locationRecords, ...profileRecords, ...organizationRecords,
    ...actorFollowRecords, ...actorFollowProfileRecords, ...actorFollowOrganizationRecords,
  ];
  for (const row of records) {
    assert.equal(row.uri, `at://${row.did}/${row.collection}/${row.rkey}`);
    assert.equal(row.record.$type, row.collection);
    assert.equal(isValidDid(row.did), true);
    if (row.collection === 'app.certified.location' || row.collection === 'app.certified.graph.follow') assert.equal(isValidTid(row.rkey), true);
    const cid = CID.fromString(row.cid);
    assert.equal(cid.version, 1);
    assert.equal(cid.codec, 0x71);
    assert.equal(cid.digest.codec, 0x12);
    assert.equal(cid.digest.contents.length, 32);
    assert.equal(row.indexedAt, '2025-01-02T03:04:05.000Z');
  }
});

test('actor-follow fixtures isolate publishers and cover date precedence, URI ties, and sparse sidecars', async () => {
  const publishers = new Set([actorFollowDids.publisher, actorFollowDids.otherPublisher]);
  assert.equal(publishers.size, 2);
  assert.equal(new Set(actorFollowRecords.map(({ uri }) => uri)).size, 7);
  assert.deepEqual(
    actorFollowRecords.filter(({ did, record }) => did === actorFollowDids.publisher && record.subject === actorFollowDids.primarySubject)
      .map(({ rkey }) => rkey).sort(),
    ['3jzfcijpj2z2a', '3jzfcijpj2z2b', '3jzfcijpj2z2c'],
  );
  const primaryPair = new Map(actorFollowRecords
    .filter(({ did, record }) => did === actorFollowDids.publisher && record.subject === actorFollowDids.primarySubject)
    .map((record) => [record.rkey, record]));
  assert.equal(primaryPair.get('3jzfcijpj2z2a').record.createdAt, '2025-01-04T00:00:00.000Z');
  assert.equal(primaryPair.get('3jzfcijpj2z2b').record.createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(primaryPair.get('3jzfcijpj2z2c').record.createdAt, '2025-01-01T00:00:00.000Z');
  assert.ok(primaryPair.get('3jzfcijpj2z2b').uri < primaryPair.get('3jzfcijpj2z2c').uri);
  assert.deepEqual(Object.keys(primaryPair.get('3jzfcijpj2z2b').record.via).sort(), ['cid', 'uri']);
  assert.deepEqual(actorFollowProfileRecords.map(({ did }) => did).sort(), [
    actorFollowDids.primarySubject, actorFollowDids.publisher, actorFollowDids.secondSubject,
  ].sort());
  assert.deepEqual(actorFollowOrganizationRecords.map(({ did }) => did).sort(), [
    actorFollowDids.primarySubject, actorFollowDids.publisher,
  ].sort());
  for (const row of [...actorFollowRecords, ...actorFollowProfileRecords, ...actorFollowOrganizationRecords]) {
    assert.equal(CID.toString(await CID.create(0x71, encode(row.record))), row.cid);
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
