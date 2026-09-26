// Deliberately malformed record dates: use only with explicitly disposable test targets.
// These bypass Lexicon validation and must never be added to records.js or routine seeding.
import { encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';

const cases = [
  ['badmissing', undefined, '2025-01-02T03:04:05.123456Z'],
  ['badnull', null, '2025-01-02T03:04:05.123456Z'],
  ['badnumber', 123, '2025-01-02T03:04:05.123456Z'],
  ['badarray', ['2025-01-01T00:00:00Z'], '2025-01-02T03:04:05.123456Z'],
  ['badtext', 'not-a-date', '2025-01-02T03:04:05.123456Z'],
  ['badnozone', '2025-01-01T00:00:00', '2025-01-02T03:04:05.123456Z'],
  ['badhour', '2025-01-01T24:00:00Z', '2025-01-02T03:04:05.123456Z'],
  ['badzone', '2025-01-01T00:00:00+00:60', '2025-01-02T03:04:05.123456Z'],
  ['badcalendar', '2025-02-29T00:00:00Z', '2025-01-02T03:04:05.123456Z'],
  ['badunindexed', 'invalid', null],
  ['goodoffset', '2025-01-02T08:34:05.123456+05:30', '2025-01-06T00:00:00Z'],
  ['goodfraction', '2025-01-02T03:04:05.123456Z', '2025-01-07T00:00:00Z'],
  ['goodnano', '2025-01-02T03:04:05.123456789Z', '2025-01-09T00:00:00Z'],
  ['goodearlier', '2025-01-01T00:00:00Z', '2025-01-08T00:00:00Z'],
];

export async function makeDateCaseRows(base, { did, decorateRecord = (record) => record }) {
  return Promise.all(cases.map(async ([rkey, createdAt, indexedAt]) => {
    const record = decorateRecord({ ...base.record }, rkey);
    if (createdAt === undefined) delete record.createdAt;
    else record.createdAt = createdAt;
    return {
      uri: `at://${did}/${base.collection}/${rkey}`, did, collection: base.collection, rkey, record, indexedAt,
      storedAt: '2025-01-02T03:04:05.123456Z',
      cid: CID.toString(await CID.create(0x71, encode(record))),
    };
  }));
}

export function badDateSeedSql(rows, { disposableTestTarget = false } = {}) {
  if (disposableTestTarget !== true) throw new Error('Bad-date seeding requires explicit disposable-test target opt-in');
  return rows.map((row) => ({
    sql: 'INSERT INTO happyview_records (uri, did, collection, rkey, record, cid, indexed_at, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (uri) DO UPDATE SET record = EXCLUDED.record, cid = EXCLUDED.cid, indexed_at = EXCLUDED.indexed_at, created_at = EXCLUDED.created_at',
    params: [row.uri, row.did, row.collection, row.rkey, JSON.stringify(row.record), row.cid, row.indexedAt, row.storedAt],
  }));
}
