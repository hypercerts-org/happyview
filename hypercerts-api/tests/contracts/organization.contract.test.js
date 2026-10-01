import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationRecords, profileRecords } from '../fixtures/records.js';
import { contractUrl, requireContractTarget } from './helpers.js';

const baseUrl = requireContractTarget();
const [publicOrganization, profilelessOrganization, unlistedOrganization] = organizationRecords;
const unlistedProfile = profileRecords.find(({ did }) => did === unlistedOrganization.did);
const organizationDids = organizationRecords.map(({ did }) => did);

function recordView(record) {
  return {
    uri: record.uri,
    cid: record.cid,
    indexedAt: record.indexedAt,
    did: record.did,
    record: record.record,
  };
}

async function get(nsid, params) {
  const response = await fetch(contractUrl(baseUrl, nsid, params));
  const body = await response.json();
  assert.equal(response.status, 200, `${nsid}: ${JSON.stringify(body)}`);
  return body;
}

async function assertDomainError(response, code) {
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, 'script_error');
  assert.equal(body.errorType, 'runtime');
  assert.match(body.message, new RegExp(`^runtime error: ${code}:`));
  assert.doesNotMatch(body.message, /SELECT|happyview_records|at:\/\//);
}

function sortOrganizations(records, direction) {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...records].sort((left, right) => {
    const time = left.record.createdAt.localeCompare(right.record.createdAt);
    if (time !== 0) return time * multiplier;
    if (left.uri === right.uri) return 0;
    return (left.uri < right.uri ? -1 : 1) * multiplier;
  });
}

test('getOrganization returns the original sidecar and explicit nullable profile', async () => {
  const withProfile = await get('app.certified.actor.getOrganization', { actor: publicOrganization.did });
  assert.deepEqual(withProfile.actor, {
    did: publicOrganization.did,
    profile: recordView(profileRecords[0]),
    organization: recordView(publicOrganization),
  });

  const withoutProfile = await get('app.certified.actor.getOrganization', { actor: profilelessOrganization.did });
  assert.deepEqual(withoutProfile.actor, {
    did: profilelessOrganization.did,
    profile: null,
    organization: recordView(profilelessOrganization),
  });
});

test('getOrganization reports a missing sidecar and rejects unaccepted founding-date parameters', async () => {
  const missing = await fetch(contractUrl(baseUrl, 'app.certified.actor.getOrganization', {
    actor: 'did:web:organization-not-seeded.example',
  }));
  await assertDomainError(missing, 'RecordNotFound');

  const unaccepted = await fetch(contractUrl(baseUrl, 'app.certified.actor.listOrganizations', {
    foundedAfter: '2020-01-01T00:00:00Z',
  }));
  await assertDomainError(unaccepted, 'InvalidRequest');
});

test('listOrganizations combines exact type and visibility filters and leaves omitted visibility unrestricted', async () => {
  const organizations = await get('app.certified.actor.listOrganizations', {
    actors: organizationDids,
    organizationTypes: ['nonprofit', 'community'],
    limit: 100,
  });
  assert.deepEqual(
    organizations.actors.map(({ organization }) => organization.uri).sort(),
    organizationRecords.map(({ uri }) => uri).sort(),
  );
  const byDid = new Map(organizations.actors.map((actor) => [actor.did, actor]));
  assert.equal(byDid.get(publicOrganization.did).organization.record.visibility, 'public');
  assert.equal(byDid.get(profilelessOrganization.did).organization.record.visibility, undefined);
  assert.equal(byDid.get(profilelessOrganization.did).profile, null);
  assert.equal(byDid.get(unlistedOrganization.did).organization.record.visibility, 'unlisted');
  assert.equal(byDid.get(unlistedOrganization.did).profile.record.displayName, unlistedProfile.record.displayName);

  const publicOnly = await get('app.certified.actor.listOrganizations', {
    actors: organizationDids, visibility: 'public',
  });
  assert.deepEqual(publicOnly.actors.map(({ organization }) => organization.uri), [publicOrganization.uri]);
  const unlistedOnly = await get('app.certified.actor.listOrganizations', {
    actors: organizationDids, visibility: 'unlisted',
  });
  assert.deepEqual(unlistedOnly.actors.map(({ organization }) => organization.uri), [unlistedOrganization.uri]);
});

test('searchOrganizations matches full trimmed literal profile text and excludes organizations without profiles', async () => {
  const result = await get('app.certified.actor.searchOrganizations', {
    search: '  Forest %_ Network  ', actors: [unlistedOrganization.did],
  });
  assert.equal(result.actors.length, 1);
  assert.equal(result.actors[0].did, unlistedOrganization.did);
  assert.equal(result.actors[0].profile.record.displayName, 'Unlisted Forest %_ Network');
  assert.deepEqual(result.actors[0].organization.record, unlistedOrganization.record);

  const absentProfile = await get('app.certified.actor.searchOrganizations', {
    search: 'community', actors: [profilelessOrganization.did],
  });
  assert.deepEqual(absentProfile.actors, []);
});

test('listOrganizations paginates stably in both directions without skipping equal-timestamp records', async () => {
  for (const direction of ['asc', 'desc']) {
    const items = [];
    let cursor;
    do {
      const page = await get('app.certified.actor.listOrganizations', {
        actors: organizationDids, sortDirection: direction, limit: 1, cursor,
      });
      assert.equal(page.actors.length, 1);
      items.push(page.actors[0].organization.uri);
      cursor = page.cursor;
    } while (cursor);

    assert.deepEqual(items, sortOrganizations(organizationRecords, direction).map(({ uri }) => uri));
    assert.equal(new Set(items).size, organizationRecords.length);
  }
});
