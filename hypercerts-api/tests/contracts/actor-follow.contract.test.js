import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actorFollowDids,
  actorFollowOrganizationRecords,
  actorFollowProfileRecords,
  actorFollowRecords,
} from '../fixtures/actor-follows.js';
import { contractUrl, requireContractTarget } from './helpers.js';

const baseUrl = requireContractTarget();
const followCollection = 'app.certified.graph.follow';
const followByRkey = new Map(actorFollowRecords.map((record) => [record.rkey, record]));

function row(rkey) {
  const record = followByRkey.get(rkey);
  assert.ok(record, `missing actor-follow fixture ${rkey}`);
  return record;
}

function recordView(record) {
  return {
    uri: record.uri,
    cid: record.cid,
    indexedAt: record.indexedAt,
    did: record.did,
    record: record.record,
  };
}

function actorView(did, follow, profile, organization) {
  return {
    did,
    profile: profile ? recordView(profile) : null,
    organization: organization ? recordView(organization) : null,
    follow: recordView(follow),
  };
}

function sidecar(records, did) {
  return records.find((record) => record.did === did);
}

async function get(nsid, params) {
  const response = await fetch(contractUrl(baseUrl, nsid, params));
  const body = await response.json();
  assert.equal(response.status, 200, `${nsid}: ${JSON.stringify(body)}`);
  return body;
}

async function collectPages(nsid, outputKey, actor, direction, pageCount) {
  const items = [];
  let cursor;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = await get(nsid, { actor, limit: 1, sortDirection: direction, cursor });
    assert.equal(page.totalCount, pageCount, `${nsid} ${direction} totalCount should be independent of pagination`);
    assert.equal(page[outputKey].length, 1, `${nsid} ${direction} page ${pageIndex + 1} should contain one relationship`);
    items.push(page[outputKey][0]);
    const hasNextPage = pageIndex < pageCount - 1;
    if (hasNextPage) {
      assert.ok(page.cursor, `${nsid} ${direction} page ${pageIndex + 1} should return a cursor`);
      cursor = page.cursor;
    } else {
      assert.equal(page.cursor, undefined, `${nsid} ${direction} final page should not return a cursor`);
    }
  }
  return items;
}

test('getFollow returns the earliest URI-tiebroken record unchanged and null for a missing pair', async () => {
  const { publisher, primarySubject, otherPublisher, secondSubject } = actorFollowDids;
  const result = await get('app.certified.graph.getFollow', { actor: publisher, subject: primarySubject });
  const representative = row('3jzfcijpj2z2b');
  assert.deepEqual(result, { follow: recordView(representative) });
  assert.deepEqual(result.follow.record.via, representative.record.via);
  assert.equal(result.follow.did, publisher);

  const missing = await get('app.certified.graph.getFollow', { actor: otherPublisher, subject: secondSubject });
  assert.deepEqual(missing, { follow: null });
});

test('follower and following queries preserve direction, publisher metadata, and nullable hydration', async () => {
  const { publisher, otherPublisher, primarySubject, secondSubject, thirdSubject } = actorFollowDids;
  const incoming = await get('app.certified.graph.listActorFollowers', {
    actor: primarySubject, sortDirection: 'asc', limit: 100,
  });
  assert.equal(incoming.totalCount, 2);
  assert.deepEqual(incoming.followers, [
    actorView(
      publisher,
      row('3jzfcijpj2z2b'),
      sidecar(actorFollowProfileRecords, publisher),
      sidecar(actorFollowOrganizationRecords, publisher),
    ),
    actorView(otherPublisher, row('3jzfcijpj2z2g'), undefined, undefined),
  ]);
  assert.equal(incoming.cursor, undefined);

  const outgoing = await get('app.certified.graph.listActorFollowing', {
    actor: publisher, sortDirection: 'asc', limit: 100,
  });
  assert.deepEqual(outgoing.following, [
    actorView(
      primarySubject,
      row('3jzfcijpj2z2b'),
      sidecar(actorFollowProfileRecords, primarySubject),
      sidecar(actorFollowOrganizationRecords, primarySubject),
    ),
    actorView(secondSubject, row('3jzfcijpj2z2d'), sidecar(actorFollowProfileRecords, secondSubject), undefined),
    actorView(thirdSubject, row('3jzfcijpj2z2f'), undefined, undefined),
  ]);
  assert.equal(outgoing.totalCount, 3);
  assert.equal(outgoing.cursor, undefined);
  assert.equal(outgoing.following[0].follow.did, publisher, 'nested record metadata identifies its publisher');
  assert.equal(outgoing.following[0].follow.record.$type, followCollection);
});

test('follower and following pages deduplicate before pagination and keep stable tuple order', async () => {
  const { publisher, otherPublisher, primarySubject } = actorFollowDids;
  const cases = [
    {
      nsid: 'app.certified.graph.listActorFollowers',
      outputKey: 'followers',
      actor: primarySubject,
      count: 2,
      asc: [row('3jzfcijpj2z2b'), row('3jzfcijpj2z2g')],
      desc: [row('3jzfcijpj2z2g'), row('3jzfcijpj2z2b')],
      ascDids: [publisher, otherPublisher],
      descDids: [otherPublisher, publisher],
    },
    {
      nsid: 'app.certified.graph.listActorFollowing',
      outputKey: 'following',
      actor: publisher,
      count: 3,
      asc: [row('3jzfcijpj2z2b'), row('3jzfcijpj2z2d'), row('3jzfcijpj2z2f')],
      desc: [row('3jzfcijpj2z2f'), row('3jzfcijpj2z2d'), row('3jzfcijpj2z2b')],
      ascDids: [actorFollowDids.primarySubject, actorFollowDids.secondSubject, actorFollowDids.thirdSubject],
      descDids: [actorFollowDids.thirdSubject, actorFollowDids.secondSubject, actorFollowDids.primarySubject],
    },
  ];

  for (const query of cases) {
    for (const direction of ['asc', 'desc']) {
      const items = await collectPages(query.nsid, query.outputKey, query.actor, direction, query.count);
      const expected = query[direction];
      assert.deepEqual(items.map(({ follow }) => follow.uri), expected.map(({ uri }) => uri));
      assert.deepEqual(items.map(({ did }) => did), query[`${direction}Dids`]);
      assert.equal(new Set(items.map(({ follow }) => follow.uri)).size, query.count, `${query.nsid} ${direction} pages repeat or omit a relationship`);
      assert.equal(items[0].follow.record.$type, followCollection);
    }
  }
});
