import test from 'node:test';
import assert from 'node:assert/strict';
import { locationRecords, profileRecords, organizationRecords, seedSql } from './records.js';

function decodeCid(cid) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of cid.slice(1)) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

test('fixtures have consistent full AT-URIs, valid DID/TID/CID identifiers, types, and fixed timestamps', () => {
  const records = [...locationRecords, ...profileRecords, ...organizationRecords];
  for (const row of records) {
    assert.equal(row.uri, `at://${row.did}/${row.collection}/${row.rkey}`);
    assert.equal(row.record.$type, row.collection);
    const cidBytes = decodeCid(row.cid);
    assert.equal(cidBytes.length, 36);
    assert.deepEqual([...cidBytes.subarray(0, 4)], [1, 0x71, 0x12, 0x20]);
    assert.equal(row.indexedAt, '2025-01-02T03:04:05.000Z');
  }
});

test('location fixtures cover the smallBlob union variant with a shaped blob reference', () => {
  const fixture = locationRecords.find(({ record }) => record.location?.$type === 'org.hypercerts.defs#smallBlob');
  assert.ok(fixture, 'expected a location fixture using the smallBlob union variant');
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
