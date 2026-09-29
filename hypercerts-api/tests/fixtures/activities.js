import { encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';

const ACTIVITY = 'org.hypercerts.claim.activity';
const CONTRIBUTOR_INFORMATION = 'org.hypercerts.claim.contributorInformation';
const PROFILE = 'app.certified.actor.profile';
const authorDid = 'did:plc:gggggggggggggggggggggggg';
const contributorDid = 'did:plc:hhhhhhhhhhhhhhhhhhhhhhhh';
const indexedAt = '2025-01-02T03:04:05.000Z';

async function row(collection, rkey, fields, did) {
  const record = { $type: collection, ...fields };
  const uri = `at://${did}/${collection}/${rkey}`;
  const cid = CID.toString(await CID.create(0x71, encode(record)));
  return { uri, did, collection, rkey, cid, indexedAt, record };
}

const staleContributorInformation = await row(CONTRIBUTOR_INFORMATION, '3jzfcijpj2z2h', {
  identifier: contributorDid, displayName: 'Old contributor name', createdAt: '2024-01-01T00:00:00Z',
}, authorDid);

export const latestContributorInformation = await row(CONTRIBUTOR_INFORMATION, '3jzfcijpj2z2h', {
  identifier: contributorDid, displayName: 'New contributor name', createdAt: '2025-01-01T00:00:00Z',
}, authorDid);

export const activityRecord = await row(ACTIVITY, '3jzfcijpj2z2i', {
  title: 'Version-pinned %_ activity fixture',
  shortDescription: 'Tests exact contributor-information version resolution.',
  createdAt: '2025-01-01T00:00:00Z',
  contributors: [
    { contributorIdentity: { uri: staleContributorInformation.uri, cid: staleContributorInformation.cid }, contributionWeight: 'first' },
    { contributorIdentity: { uri: staleContributorInformation.uri, cid: staleContributorInformation.cid }, contributionWeight: 'second' },
    { contributorIdentity: { identity: contributorDid }, contributionWeight: 'inline' },
    { contributorIdentity: { identity: 'https://example.org/manual-contributor' }, contributionWeight: 'external' },
  ],
}, authorDid);

export const staleOnlyActivityRecord = await row(ACTIVITY, '3jzfcijpj2z2j', {
  title: 'Stale contributor reference',
  shortDescription: 'The only contributor identity is pinned to a missing older version.',
  createdAt: '2025-01-02T00:00:00Z',
  contributors: [{ contributorIdentity: { uri: staleContributorInformation.uri, cid: staleContributorInformation.cid } }],
}, authorDid);

export const activityAuthorProfile = await row(PROFILE, 'self', {
  displayName: 'Activity fixture author', createdAt: indexedAt,
}, authorDid);

export const activityContributorProfile = await row(PROFILE, 'self', {
  displayName: 'Inline activity contributor', createdAt: indexedAt,
}, contributorDid);

export const activityContributorInformationVersions = [staleContributorInformation, latestContributorInformation];
export const activityFixtureRows = [
  activityRecord,
  staleOnlyActivityRecord,
  latestContributorInformation,
  activityAuthorProfile,
  activityContributorProfile,
];
