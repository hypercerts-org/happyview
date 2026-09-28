import { encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';

const followCollection = 'app.certified.graph.follow';
const profileCollection = 'app.certified.actor.profile';
const organizationCollection = 'app.certified.actor.organization';
const indexedAt = '2025-01-02T03:04:05.000Z';

export const actorFollowDids = {
  publisher: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  otherPublisher: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
  primarySubject: 'did:plc:cccccccccccccccccccccccc',
  secondSubject: 'did:plc:dddddddddddddddddddddddd',
  thirdSubject: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee',
  curator: 'did:plc:ffffffffffffffffffffffff',
};

async function row(collection, rkey, fields, did) {
  const record = { $type: collection, ...fields };
  const uri = `at://${did}/${collection}/${rkey}`;
  const cid = CID.toString(await CID.create(0x71, encode(record)));
  return { uri, did, collection, rkey, cid, indexedAt, record };
}

export const actorFollowRecords = await Promise.all([
  row(followCollection, '3jzfcijpj2z2a', {
    subject: actorFollowDids.primarySubject,
    createdAt: '2025-01-04T00:00:00.000Z',
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2b', {
    subject: actorFollowDids.primarySubject,
    createdAt: '2025-01-01T00:00:00.000Z',
    via: {
      uri: `at://${actorFollowDids.curator}/app.certified.graph.list/3jzfcijpj2z2a`,
      cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    },
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2c', {
    subject: actorFollowDids.primarySubject,
    createdAt: '2025-01-01T00:00:00.000Z',
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2d', {
    subject: actorFollowDids.secondSubject,
    createdAt: '2025-01-02T00:00:00.000Z',
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2e', {
    subject: actorFollowDids.secondSubject,
    createdAt: '2025-01-02T00:00:00.000Z',
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2f', {
    subject: actorFollowDids.thirdSubject,
    createdAt: '2025-01-02T00:00:00.000Z',
  }, actorFollowDids.publisher),
  row(followCollection, '3jzfcijpj2z2g', {
    subject: actorFollowDids.primarySubject,
    createdAt: '2025-01-02T00:00:00.000Z',
  }, actorFollowDids.otherPublisher),
]);

export const actorFollowProfileRecords = await Promise.all([
  row(profileCollection, 'self', {
    displayName: 'Follow fixture publisher',
    createdAt: indexedAt,
  }, actorFollowDids.publisher),
  row(profileCollection, 'self', {
    displayName: 'Follow fixture primary subject',
    createdAt: indexedAt,
  }, actorFollowDids.primarySubject),
  row(profileCollection, 'self', {
    displayName: 'Follow fixture second subject',
    createdAt: indexedAt,
  }, actorFollowDids.secondSubject),
]);

export const actorFollowOrganizationRecords = await Promise.all([
  row(organizationCollection, 'self', {
    organizationType: ['nonprofit'],
    visibility: 'public',
    createdAt: indexedAt,
  }, actorFollowDids.publisher),
  row(organizationCollection, 'self', {
    organizationType: ['community'],
    visibility: 'public',
    createdAt: indexedAt,
  }, actorFollowDids.primarySubject),
]);
