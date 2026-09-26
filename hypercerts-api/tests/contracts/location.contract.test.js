import test from 'node:test';
import assert from 'node:assert/strict';
import { locationRecords, profileRecords, organizationRecords } from '../fixtures/records.js';
import { contractUrl, requireContractTarget } from './helpers.js';

const baseUrl = requireContractTarget();
const [forest, river, blobLocation, emptyTypeLocation, noRelations, profileOnly, organizationOnly] = locationRecords;

async function get(nsid, params) {
  const response = await fetch(contractUrl(baseUrl, nsid, params));
  const body = await response.json();
  assert.equal(response.status, 200, `${nsid}: ${JSON.stringify(body)}`);
  return body;
}

function cursorWithTimestamp(cursor, timestamp) {
  const value = JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'));
  value.t = timestamp;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
}

async function assertDomainError(response, code) {
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, 'script_error');
  assert.equal(body.errorType, 'runtime');
  assert.match(body.message, new RegExp(`^runtime error: ${code}:`));
  assert.doesNotMatch(body.message, /SELECT|happyview_records|at:\/\//);
}

test('getLocation returns complete location metadata and nullable hydrated author relations', async () => {
  const result = await get('app.certified.location.getLocation', { uri: forest.uri });
  assert.equal(result.location.uri, forest.uri);
  assert.equal(result.location.cid, forest.cid);
  assert.equal(result.location.did, forest.did);
  assert.ok(result.location.indexedAt);
  assert.equal(result.location.record.$type, 'app.certified.location');
  assert.equal(result.location.record.name, 'Thimphu Forest');
  assert.equal(result.location.author.did, forest.did);
  assert.deepEqual(result.location.author.profile, {
    uri: profileRecords[0].uri, cid: profileRecords[0].cid, did: profileRecords[0].did,
    indexedAt: profileRecords[0].indexedAt, record: profileRecords[0].record,
  });
  assert.deepEqual(result.location.author.organization, {
    uri: organizationRecords[0].uri, cid: organizationRecords[0].cid, did: organizationRecords[0].did,
    indexedAt: organizationRecords[0].indexedAt, record: organizationRecords[0].record,
  });
});

test('getLocation preserves a blob-backed location reference', async () => {
  const result = await get('app.certified.location.getLocation', { uri: blobLocation.uri });
  assert.deepEqual(result.location.record.location, blobLocation.record.location);
});

test('getLocation missing URI fails as a record-not-found error, not an empty view', async () => {
  const response = await fetch(contractUrl(baseUrl, 'app.certified.location.getLocation', { uri: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.certified.location/3jzfcijpj2z2z' }));
  await assertDomainError(response, 'RecordNotFound');
});

test('listLocations applies repeated authors, URI and open location-type filters together', async () => {
  const result = await get('app.certified.location.listLocations', {
    authors: [forest.did], uris: [forest.uri, river.uri], locationTypes: ['geojson', 'address'], limit: 100, sortDirection: 'asc',
  });
  assert.deepEqual(result.locations.map(({ uri }) => uri).sort(), [forest.uri, river.uri].sort());
  assert.equal(result.cursor, undefined);
});

test('listLocations returns an empty array and omits a terminal cursor', async () => {
  const result = await get('app.certified.location.listLocations', { locationTypes: ['not-a-fixture-type'] });
  assert.deepEqual(result.locations, []);
  assert.equal(result.cursor, undefined);
});

test('author hydration keeps records visible for all profile and organization combinations', async () => {
  const result = await get('app.certified.location.listLocations', { uris: [noRelations.uri, profileOnly.uri, organizationOnly.uri] });
  const byUri = new Map(result.locations.map((location) => [location.uri, location.author]));
  assert.deepEqual(byUri.get(noRelations.uri), { did: noRelations.did, profile: null, organization: null });
  assert.equal(byUri.get(profileOnly.uri).profile.did, profileOnly.did);
  assert.equal(byUri.get(profileOnly.uri).organization, null);
  assert.equal(byUri.get(organizationOnly.uri).profile, null);
  assert.equal(byUri.get(organizationOnly.uri).organization.did, organizationOnly.did);
});

test('empty locationType matches the fixture value', async () => {
  const result = await get('app.certified.location.listLocations', { locationTypes: [''] });
  assert.deepEqual(result.locations.map(({ uri }) => uri), [emptyTypeLocation.uri]);
});

test('listLocations paginates deterministically in both directions without changing filters', async () => {
  for (const direction of ['asc', 'desc']) {
    const all = [];
    let cursor;
    do {
      const page = await get('app.certified.location.listLocations', { authors: [forest.did, noRelations.did], limit: 2, sortDirection: direction, cursor });
      all.push(...page.locations.map(({ uri }) => uri));
      cursor = page.cursor;
    } while (cursor);
    const expected = [forest, river, blobLocation, emptyTypeLocation, noRelations].sort((a, b) => {
      const delta = Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt);
      return (delta || a.uri.localeCompare(b.uri)) * (direction === 'asc' ? 1 : -1);
    }).map(({ uri }) => uri);
    assert.deepEqual(all, expected);
  }
});

test('listLocations cursor stores the UTC database instant, not the record timezone', async () => {
  const page = await get('app.certified.location.listLocations', {
    uris: [forest.uri, river.uri, blobLocation.uri, emptyTypeLocation.uri, noRelations.uri],
    sortDirection: 'asc', limit: 4,
  });
  assert.equal(page.locations.at(-1).uri, emptyTypeLocation.uri);
  const token = JSON.parse(Buffer.from(page.cursor, 'hex').toString('utf8'));
  assert.equal(token.t, '2025-01-03T23:00:00.000000Z');
});

test('listLocations accepts 100 supplied filter occurrences before deduplication', async () => {
  const result = await get('app.certified.location.listLocations', { authors: Array(100).fill(forest.did), limit: 100 });
  assert.equal(result.locations.length, 4);
  assert.equal(new Set(result.locations.map(({ uri }) => uri)).size, 4);
});

test('listLocations rejects malformed or direction-mismatched cursors and invalid bounds', async () => {
  const firstPage = await get('app.certified.location.listLocations', { limit: 1 });
  const oppositeDirection = cursorWithTimestamp(firstPage.cursor, firstPage.locations[0].record.createdAt);
  for (const params of [
    { cursor: 'bad!' }, { cursor: oppositeDirection, sortDirection: 'asc' },
    { limit: 0 }, { limit: 101 }, { authors: Array(101).fill(forest.did) },
    { authors: ['alice.example'] }, { uris: ['at://alice.example/app.certified.location/x'] },
    { search: 'forest' }, { unknown: 'value' }, { limit: [1, 2] },
  ]) {
    const response = await fetch(contractUrl(baseUrl, 'app.certified.location.listLocations', params));
    await assertDomainError(response, 'InvalidRequest');
  }
});

test('listLocations rejects malformed cursor datetime and ATProto identifiers', async () => {
  const firstPage = await get('app.certified.location.listLocations', { limit: 1 });
  assert.ok(firstPage.cursor);
  const invalid = [
    ...['2025-01-01Tgarbage', '2025-02-29T00:00:00Z', '2025-13-01T00:00:00Z', '2025-01-01T24:00:00Z', '2025-01-01T00:00:60Z', '2025-01-01T00:00:00Z trailing', '2025-01-01T00:00:00', '2025-01-01T00:00:00-00:00']
      .map((timestamp) => ({ cursor: cursorWithTimestamp(firstPage.cursor, timestamp) })),
    { authors: ['did:plc:abc:'] }, { authors: ['did:1:abc'] }, { authors: [`did:${'a'.repeat(2045)}`] },
    { uris: ['at://did:plc:abcdefghijklmnopqrstuvwx/app.certified.location/.'] },
    { uris: ['at://did:plc:abcdefghijklmnopqrstuvwx/app.certified.location/..'] },
    { uris: [`at://did:plc:abcdefghijklmnopqrstuvwx/app.certified.location/${'a'.repeat(513)}`] },
  ];
  for (const params of invalid) {
    const response = await fetch(contractUrl(baseUrl, 'app.certified.location.listLocations', params));
    await assertDomainError(response, 'InvalidRequest');
  }
  for (const timestamp of ['2024-02-29T23:59:59.123456789Z', '2025-01-01T00:00:00.123+05:30']) {
    const response = await fetch(contractUrl(baseUrl, 'app.certified.location.listLocations', {
      cursor: cursorWithTimestamp(firstPage.cursor, timestamp), authors: ['did:web:example.com%3A443:user'],
    }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).locations, []);
  }
});
