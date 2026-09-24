import test from 'node:test';
import assert from 'node:assert/strict';
import { badDateLocations, badDateSeedSql } from './bad-location-dates.js';
import { locationRecords, profileRecords, organizationRecords } from './records.js';

test('bad-date rows require explicit disposable-target opt-in and preserve malformed JSON values', () => {
  assert.throws(() => badDateSeedSql(), /disposable-test target opt-in/);
  const statements = badDateSeedSql({ disposableTestTarget: true });
  assert.equal(statements.length, badDateLocations.length);
  const missing = statements.find(({ params }) => params[3] === 'badmissing');
  const absent = JSON.parse(missing.params[4]);
  assert.equal(Object.hasOwn(absent, 'createdAt'), false);
  const unindexed = statements.find(({ params }) => params[3] === 'badunindexed');
  assert.equal(unindexed.params[6], null);
  assert.equal(unindexed.params[7], '2025-01-02T03:04:05.123456Z');
});

test('bad-date fixtures have their own author and do not match normal fixture filters', () => {
  const normal = [...locationRecords, ...profileRecords, ...organizationRecords];
  const normalDids = new Set(normal.map(({ did }) => did));
  const normalUris = new Set(normal.map(({ uri }) => uri));
  assert.equal(new Set(badDateLocations.map(({ uri }) => uri)).size, badDateLocations.length);
  for (const row of badDateLocations) {
    assert.equal(row.did, 'did:web:bad-date-fixtures.example');
    assert.equal(row.uri, `at://${row.did}/${row.collection}/${row.rkey}`);
    assert.equal(normalDids.has(row.did), false);
    assert.equal(normalUris.has(row.uri), false);
    assert.equal(row.record.locationType, 'date-test');
    assert.equal(`${row.record.name} ${row.record.description}`.toLowerCase().includes('community forest'), false);
    assert.equal(`${row.record.name} ${row.record.description}`.includes(String.raw`100%_\path`), false);
  }
  const statements = badDateSeedSql({ disposableTestTarget: true });
  for (let i = 0; i < statements.length; i++) {
    assert.equal(statements[i].params[0], badDateLocations[i].uri);
    assert.equal(statements[i].params[1], badDateLocations[i].did);
  }
});
