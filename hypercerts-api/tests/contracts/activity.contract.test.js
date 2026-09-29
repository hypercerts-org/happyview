import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityContributorProfile,
  activityRecord,
  activityAuthorProfile,
  organizationOnlyActivityRecord,
  profilelessActivityRecord,
  staleOnlyActivityRecord,
} from '../fixtures/activities.js';
import { contractUrl, requireContractTarget } from './helpers.js';

const baseUrl = requireContractTarget();
const authorDid = activityRecord.did;
const contributorDid = activityContributorProfile.did;

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

test('getActivity preserves its source record and hydrates contributor versions and actors faithfully', async () => {
  const result = await get('org.hypercerts.claim.getActivity', { uri: activityRecord.uri });
  assert.deepEqual(result.activity.record, activityRecord.record);
  assert.deepEqual(result.activity.author, {
    did: authorDid,
    profile: recordView(activityAuthorProfile),
    organization: null,
  });

  const contributors = result.activity.contributors;
  assert.equal(contributors.length, activityRecord.record.contributors.length);
  assert.deepEqual(contributors.map(({ contributionWeight }) => contributionWeight), ['first', 'second', 'inline', 'external']);
  for (const stale of contributors.slice(0, 2)) {
    assert.equal(stale.contributorInformation, null);
    assert.equal(stale.actor, null, 'the newer CID at the same URI must not supply an identity');
  }
  assert.equal(contributors[2].contributorInformation, null);
  assert.deepEqual(contributors[2].actor, {
    did: contributorDid,
    profile: recordView(activityContributorProfile),
  });
  assert.equal(contributors[3].contributorInformation, null);
  assert.equal(contributors[3].actor, null);
});

test('listActivities filters by contributor DID only when the exact referenced version is available', async () => {
  const result = await get('org.hypercerts.claim.listActivities', {
    authors: [authorDid],
    hasOrganizationRecord: false,
    contributors: [contributorDid],
    involvedActors: [contributorDid],
    uris: [activityRecord.uri, staleOnlyActivityRecord.uri],
    sortDirection: 'asc',
    limit: 100,
  });
  assert.deepEqual(result.activities.map(({ uri }) => uri), [activityRecord.uri]);

  const staleOnly = await get('org.hypercerts.claim.listActivities', {
    contributors: [contributorDid], uris: [staleOnlyActivityRecord.uri],
  });
  assert.deepEqual(staleOnly.activities, []);
});

test('listActivities filters by organization self-record presence independently of profiles', async () => {
  const organizationAuthor = await get('org.hypercerts.claim.listActivities', {
    authors: [organizationOnlyActivityRecord.did], hasOrganizationRecord: true,
  });
  assert.deepEqual(organizationAuthor.activities.map(({ uri }) => uri), [organizationOnlyActivityRecord.uri]);
  assert.equal(organizationAuthor.activities[0].author.profile, null);
  assert.equal(organizationAuthor.activities[0].author.organization.did, organizationOnlyActivityRecord.did);
  assert.equal(organizationAuthor.activities[0].author.organization.record.organizationType[0], 'community');

  const organizationExcluded = await get('org.hypercerts.claim.listActivities', {
    authors: [organizationOnlyActivityRecord.did], hasOrganizationRecord: false,
  });
  assert.deepEqual(organizationExcluded.activities, []);

  const profilelessAuthor = await get('org.hypercerts.claim.listActivities', {
    authors: [profilelessActivityRecord.did], hasOrganizationRecord: false,
  });
  assert.deepEqual(profilelessAuthor.activities.map(({ uri }) => uri), [profilelessActivityRecord.uri]);
  assert.equal(profilelessAuthor.activities[0].author.profile, null);
  assert.equal(profilelessAuthor.activities[0].author.organization, null);

  const profilelessExcluded = await get('org.hypercerts.claim.listActivities', {
    authors: [profilelessActivityRecord.did], hasOrganizationRecord: true,
  });
  assert.deepEqual(profilelessExcluded.activities, []);
});

test('searchActivities treats wildcard characters literally and applies URI filters', async () => {
  const result = await get('org.hypercerts.claim.searchActivities', {
    search: '  pinned %_ activity  ',
    uris: [activityRecord.uri, staleOnlyActivityRecord.uri],
  });
  assert.deepEqual(result.activities.map(({ uri }) => uri), [activityRecord.uri]);
  assert.deepEqual(result.activities[0].author.profile, recordView(activityAuthorProfile));
});

test('getActivity distinguishes an unindexed URI from a successful empty listing', async () => {
  const missing = await fetch(contractUrl(baseUrl, 'org.hypercerts.claim.getActivity', {
    uri: `at://${authorDid}/org.hypercerts.claim.activity/missing`,
  }));
  await assertDomainError(missing, 'RecordNotFound');

  const empty = await get('org.hypercerts.claim.listActivities', {
    uris: [`at://${authorDid}/org.hypercerts.claim.activity/missing`],
  });
  assert.deepEqual(empty.activities, []);
  assert.equal(empty.cursor, undefined);
});
