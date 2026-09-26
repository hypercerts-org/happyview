// Run only after badDateSeedSql has been loaded into an approved disposable target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { badDateLocations } from '../fixtures/bad-location-dates.js';
import { contractUrl, requireContractTarget } from './helpers.js';

const baseUrl = requireContractTarget();
const byKey = new Map(badDateLocations.map((row) => [row.rkey, row]));
const asc = ['goodearlier', 'badarray', 'badcalendar', 'badhour', 'badmissing', 'badnozone', 'badnull', 'badnumber', 'badtext', 'badunindexed', 'badzone', 'goodfraction', 'goodoffset', 'goodnano'];
const tiedAt = '2025-01-02T03:04:05.123456Z';
const expectedTime = (rkey) => rkey === 'goodearlier' ? '2025-01-01T00:00:00.000000Z' : rkey === 'goodnano' ? '2025-01-02T03:04:05.123457Z' : tiedAt;

async function request(nsid, params) {
  const response = await fetch(contractUrl(baseUrl, nsid, params));
  const body = await response.json();
  assert.equal(response.status, 200, `${nsid}: ${JSON.stringify(body)}`);
  return body;
}

test('bad or absent createdAt falls back without hiding or changing records in getLocation', async () => {
  for (const fixture of badDateLocations) {
    const body = await request('app.certified.location.getLocation', { uri: fixture.uri });
    assert.equal(body.location.uri, fixture.uri);
    assert.deepEqual(body.location.record, fixture.record);
  }
});

test('bad dates and equal instants paginate without gaps in either direction using the DB key', async () => {
  const uris = badDateLocations.map(({ uri }) => uri);
  for (const direction of ['asc', 'desc']) {
    const expected = direction === 'asc' ? asc : [...asc].reverse();
    const seen = [];
    let cursor;
    do {
      const page = await request('app.certified.location.listLocations', {
        uris, limit: 3, sortDirection: direction, cursor,
      });
      for (const view of page.locations) {
        const key = view.uri.slice(view.uri.lastIndexOf('/') + 1);
        seen.push(key);
        assert.deepEqual(view.record, byKey.get(key).record);
      }
      cursor = page.cursor;
      if (cursor) {
        const token = JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'));
        const last = seen.at(-1);
        assert.equal(token.t, expectedTime(last));
        assert.equal(token.u, byKey.get(last).uri);
        assert.equal(token.d, direction);
      }
    } while (cursor);
    assert.deepEqual(seen, expected);
  }
});
