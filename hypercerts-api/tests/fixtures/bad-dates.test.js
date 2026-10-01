import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDateCaseRows, badDateSeedSql } from './bad-dates.js';
import { profileRecords } from './records.js';

test('date cases apply to a different record collection without changing the base fixture', async () => {
  const base = profileRecords[0];
  const rows = await makeDateCaseRows(base, { did: 'did:web:bad-date-profiles.example' });
  const missing = rows.find(({ rkey }) => rkey === 'badmissing');
  const malformed = rows.find(({ rkey }) => rkey === 'badcalendar');
  const offset = rows.find(({ rkey }) => rkey === 'goodoffset');
  assert.equal(missing.uri, 'at://did:web:bad-date-profiles.example/app.certified.actor.profile/badmissing');
  assert.equal(missing.record.$type, 'app.certified.actor.profile');
  assert.equal(missing.record.displayName, 'Test Publisher');
  assert.equal(Object.hasOwn(missing.record, 'createdAt'), false);
  assert.equal(malformed.record.createdAt, '2025-02-29T00:00:00Z');
  assert.equal(offset.record.createdAt, '2025-01-02T08:34:05.123456+05:30');
  assert.equal(rows.find(({ rkey }) => rkey === 'badunindexed').indexedAt, null);
  assert.equal(base.record.createdAt, '2025-01-02T03:04:05.000Z');
  assert.ok(rows.every(({ collection, cid }) => collection === base.collection && typeof cid === 'string'));
});

test('shared date rows require disposable-target opt-in before producing seed SQL', async () => {
  const rows = await makeDateCaseRows(profileRecords[0], { did: 'did:web:bad-date-profiles.example' });
  assert.throws(() => badDateSeedSql(rows), /disposable-test target opt-in/);
  const statements = badDateSeedSql(rows, { disposableTestTarget: true });
  assert.equal(statements.length, 14);
  const missing = statements.find(({ params }) => params[3] === 'badmissing');
  assert.equal(missing.params[2], 'app.certified.actor.profile');
  assert.equal(Object.hasOwn(JSON.parse(missing.params[4]), 'createdAt'), false);
  const unindexed = statements.find(({ params }) => params[3] === 'badunindexed');
  assert.equal(unindexed.params[6], null);
  assert.equal(unindexed.params[7], '2025-01-02T03:04:05.123456Z');
});
