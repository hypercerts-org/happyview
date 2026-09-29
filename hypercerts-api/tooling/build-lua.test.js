import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLuaBundles, checkLuaBundles } from './lua-bundles.js';

const sources = [
  ['lua/shared/collection.lua', 'local function collection_view() return "collection" end\n'],
  ['lua/shared/collectionList.lua', 'local function collection_list_response() return collection_view() end\n'],
  ['lua/shared/collectionItems.lua', 'local function collection_items_response() return activity_projection() end\n'],
  ['lua/shared/entityFollow.lua', 'local function entity_follow_common() return "entity follow" end\n'],
  ['lua/shared/entityFollowLookup.lua', 'local function entity_follow_lookup_shared() return "lookup" end\n'],
  ['lua/shared/entityFollowPagination.lua', 'local function entity_follow_pagination_shared() return "pagination" end\n'],
  ['lua/shared/entityFollowFollowers.lua', 'local function entity_follow_followers_shared() return "followers" end\n'],
  ['lua/shared/entityFollowEntities.lua', 'local function entity_follow_entities() return activity_projection() .. collection_projection() .. feature_projection() end\n'],
  ['lua/src/listCollectionItems.lua', 'function handle() return collection_items_response() end\n'],
  ['lua/src/getCollection.lua', 'function handle() return collection_view() end\n'],
  ['lua/src/listCollections.lua', 'function handle() return collection_list_response(false) end\n'],
  ['lua/src/searchCollections.lua', 'function handle() return collection_list_response(true) end\n'],
  ['lua/shared/query.lua', 'local function query_common() return "query" end\n'],

  ['lua/shared/recordIdentifier.lua', 'local function record_identifier_common() return "identifier" end\n'],
  ['lua/shared/listQuery.lua', 'local function list_query_common() return "list query" end\n'],
  ['lua/shared/recordView.lua', 'local function record_view_common() return "record" end\n'],
  ['lua/shared/actorView.lua', 'local function actor_view_common() return "actor" end\n'],
  ['lua/shared/location.lua', 'local function query() return "location" end\n'],
  ['lua/shared/actorFollow.lua', 'local function query() return "follow" end\n'],
  ['lua/shared/actorFollowLookup.lua', 'local function lookup() return true end\n'],
  ['lua/shared/actorFollowList.lua', 'local function list() return true end\n'],
  ['lua/shared/recentFollows.lua', 'local function recent_follows_response() return "recent follows" end\n'],
  ['lua/shared/profile.lua', 'local function row_view() return "profile" end\n'],
  ['lua/shared/profileLookup.lua', 'local function lookup() return row_view() end\n'],
  ['lua/shared/profileList.lua', 'local function profiles_response() return row_view() end\n'],
  ['lua/shared/organization.lua', 'local function organization_actor_view() return row_view() end\n'],
  ['lua/shared/organizationList.lua', 'local function organizations_response() return organization_actor_view() end\n'],
  ['lua/shared/activity.lua', 'local function activity_view() return "activity" end\n'],
  ['lua/shared/activityProjection.lua', 'local function activity_projection() return "activity" end\n'],
  ['lua/shared/collectionProjection.lua', 'local function collection_projection() return "collection" end\n'],
  ['lua/shared/featureProjection.lua', 'local function feature_projection() return "feature" end\n'],
  ['lua/shared/activityList.lua', 'local function activity_list_response(search_enabled) return search_enabled end\n'],
  ['lua/src/getActivity.lua', 'function handle() return activity_view() end\n'],
  ['lua/src/listActivities.lua', 'function handle() return activity_list_response(false) end\n'],
  ['lua/src/searchActivities.lua', 'function handle() return activity_list_response(true) end\n'],
  ['lua/src/getOrganization.lua', 'function handle() return organization_actor_view() end\n'],
  ['lua/src/listOrganizations.lua', 'function handle() return organizations_response(false) end\n'],
  ['lua/src/searchOrganizations.lua', 'function handle() return organizations_response(true) end\n'],
  ['lua/src/getLocation.lua', 'function handle() return query() end\n'],
  ['lua/src/listLocations.lua', 'function handle() return query() end\n'],
  ['lua/src/getFollow.lua', 'function handle() return query() end\n'],
  ['lua/src/listActorFollowers.lua', 'function handle() return list() end\n'],
  ['lua/src/listActorFollowing.lua', 'function handle() return list() end\n'],
  ['lua/src/getEntityFollow.lua', 'function handle() return entity_follow_common() end\n'],
  ['lua/src/listEntityFollowers.lua', 'function handle() return entity_follow_common() end\n'],
  ['lua/src/listEntityFollowing.lua', 'function handle() return entity_follow_entities() end\n'],
  ['lua/src/listRecentFollows.lua', 'function handle() return recent_follows_response() end\n'],
  ['lua/src/getProfile.lua', 'function handle() return lookup() end\n'],
  ['lua/src/listProfiles.lua', 'function handle() return profiles_response(false) end\n'],
  ['lua/src/searchProfiles.lua', 'function handle() return profiles_response(true) end\n'],
];

async function withLuaRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hypercerts-api-build-lua-'));
  try {
    for (const [relativePath, content] of sources) {
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await mkdir(path.join(root, 'lua/endpoints'));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('builds collection lookup, listing, and search handlers from their declared sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    const projection = 'local function collection_projection() return "collection" end';
    const common = 'local function collection_view() return "collection" end';
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/getCollection.lua'), 'utf8'),
      [projection, common, 'function handle() return collection_view() end'].join('\n\n') + '\n',
    );
    for (const [name, searchEnabled] of [['listCollections', false], ['searchCollections', true]]) {
      assert.equal(
        await readFile(path.join(root, `lua/endpoints/${name}.lua`), 'utf8'),
        [
          projection,
          common,
          'local function collection_list_response() return collection_view() end',
          `function handle() return collection_list_response(${searchEnabled}) end`,
        ].join('\n\n') + '\n',
      );
    }
  });
});

test('builds listCollectionItems with the shared activity-view implementation', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/listCollectionItems.lua'), 'utf8'),
      [
        'local function query_common() return "query" end',
        'local function record_identifier_common() return "identifier" end',
        'local function activity_projection() return "activity" end',
        'local function feature_projection() return "feature" end',
        'local function collection_items_response() return activity_projection() end',
        'function handle() return collection_items_response() end',
      ].join('\n\n') + '\n',
    );
  });
});

test('builds a handler bundle from its shared and endpoint sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/getLocation.lua'), 'utf8'),
      [
        'local function query_common() return "query" end',
        'local function record_identifier_common() return "identifier" end',
        'local function record_view_common() return "record" end',
        'local function actor_view_common() return "actor" end',
        'local function query() return "location" end',
        'function handle() return query() end',
      ].join('\n\n') + '\n',
    );
  });
});

test('builds entity-follow handlers in declared shared-source dependency order', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    const base = [
      'local function query_common() return "query" end',
      'local function record_identifier_common() return "identifier" end',
    ];
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/getEntityFollow.lua'), 'utf8'),
      [
        ...base,
        'local function entity_follow_common() return "entity follow" end',
        'local function entity_follow_lookup_shared() return "lookup" end',
        'function handle() return entity_follow_common() end',
      ].join('\n\n') + '\n',
    );
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/listEntityFollowers.lua'), 'utf8'),
      [
        ...base,
        'local function list_query_common() return "list query" end',
        'local function entity_follow_common() return "entity follow" end',
        'local function entity_follow_pagination_shared() return "pagination" end',
        'local function entity_follow_followers_shared() return "followers" end',
        'function handle() return entity_follow_common() end',
      ].join('\n\n') + '\n',
    );
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/listEntityFollowing.lua'), 'utf8'),
      [
        ...base,
        'local function list_query_common() return "list query" end',
        'local function activity_projection() return "activity" end',
        'local function collection_projection() return "collection" end',
        'local function feature_projection() return "feature" end',
        'local function entity_follow_common() return "entity follow" end',
        'local function entity_follow_pagination_shared() return "pagination" end',
        'local function entity_follow_entities() return activity_projection() .. collection_projection() .. feature_projection() end',
        'function handle() return entity_follow_entities() end',
      ].join('\n\n') + '\n',
    );
  });
});

test('builds listRecentFollows from its declared shared and endpoint sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/listRecentFollows.lua'), 'utf8'),
      [
        'local function query_common() return "query" end',
        'local function recent_follows_response() return "recent follows" end',
        'function handle() return recent_follows_response() end',
      ].join('\n\n') + '\n',
    );
  });
});

test('builds the organization lookup from its declared shared and endpoint sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/getOrganization.lua'), 'utf8'),
      [
        'local function organization_actor_view() return row_view() end',
        'function handle() return organization_actor_view() end',
      ].join('\n\n') + '\n',
    );
  });
});

test('builds listing and search handlers from their declared organization sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    for (const name of ['listOrganizations', 'searchOrganizations']) {
      assert.equal(
        await readFile(path.join(root, `lua/endpoints/${name}.lua`), 'utf8'),
        [
          'local function organization_actor_view() return row_view() end',
          'local function organizations_response() return organization_actor_view() end',
          `function handle() return organizations_response(${name === 'searchOrganizations'}) end`,
        ].join('\n\n') + '\n',
      );
    }
  });
});

test('builds get, list, and search activity handlers from their declared sources', async () => {
  await withLuaRoot(async (root) => {
    await buildLuaBundles(root);
    assert.equal(
      await readFile(path.join(root, 'lua/endpoints/getActivity.lua'), 'utf8'),
      [
        'local function activity_projection() return "activity" end',
        'local function activity_view() return "activity" end',
        'function handle() return activity_view() end',
      ].join('\n\n') + '\n',
    );
    for (const [name, searchEnabled] of [['listActivities', false], ['searchActivities', true]]) {
      assert.equal(
        await readFile(path.join(root, `lua/endpoints/${name}.lua`), 'utf8'),
        [
          'local function activity_projection() return "activity" end',
          'local function activity_view() return "activity" end',
          'local function activity_list_response(search_enabled) return search_enabled end',
          `function handle() return activity_list_response(${searchEnabled}) end`,
        ].join('\n\n') + '\n',
      );
    }
  });
});

test('checks generated bundles without rewriting stale outputs', async () => {
  await withLuaRoot(async (root) => {
    const expectedStale = [
      'lua/endpoints/getCollection.lua',
      'lua/endpoints/listCollections.lua',
      'lua/endpoints/searchCollections.lua',
      'lua/endpoints/listCollectionItems.lua',
      'lua/endpoints/getLocation.lua',
      'lua/endpoints/getActivity.lua',
      'lua/endpoints/listActivities.lua',
      'lua/endpoints/searchActivities.lua',
      'lua/endpoints/listLocations.lua',
      'lua/endpoints/getFollow.lua',
      'lua/endpoints/listActorFollowers.lua',
      'lua/endpoints/listActorFollowing.lua',
      'lua/endpoints/getEntityFollow.lua',
      'lua/endpoints/listEntityFollowers.lua',
      'lua/endpoints/listEntityFollowing.lua',
      'lua/endpoints/listRecentFollows.lua',
      'lua/endpoints/getProfile.lua',
      'lua/endpoints/listProfiles.lua',
      'lua/endpoints/searchProfiles.lua',
      'lua/endpoints/getOrganization.lua',
      'lua/endpoints/listOrganizations.lua',
      'lua/endpoints/searchOrganizations.lua',
    ];
    for (const relativePath of expectedStale) {
      await writeFile(path.join(root, relativePath), 'stale bundle\n');
    }

    assert.deepEqual(await checkLuaBundles(root), expectedStale);
    for (const relativePath of expectedStale) {
      assert.equal(await readFile(path.join(root, relativePath), 'utf8'), 'stale bundle\n');
    }
  });
});

test('reports missing generated bundles and accepts fresh bundles', async () => {
  await withLuaRoot(async (root) => {
    const expected = [
      'lua/endpoints/getCollection.lua',
      'lua/endpoints/listCollections.lua',
      'lua/endpoints/searchCollections.lua',
      'lua/endpoints/listCollectionItems.lua',
      'lua/endpoints/getLocation.lua',
      'lua/endpoints/getActivity.lua',
      'lua/endpoints/listActivities.lua',
      'lua/endpoints/searchActivities.lua',
      'lua/endpoints/listLocations.lua',
      'lua/endpoints/getFollow.lua',
      'lua/endpoints/listActorFollowers.lua',
      'lua/endpoints/listActorFollowing.lua',
      'lua/endpoints/getEntityFollow.lua',
      'lua/endpoints/listEntityFollowers.lua',
      'lua/endpoints/listEntityFollowing.lua',
      'lua/endpoints/listRecentFollows.lua',
      'lua/endpoints/getProfile.lua',
      'lua/endpoints/listProfiles.lua',
      'lua/endpoints/searchProfiles.lua',
      'lua/endpoints/getOrganization.lua',
      'lua/endpoints/listOrganizations.lua',
      'lua/endpoints/searchOrganizations.lua',
    ];
    assert.deepEqual(await checkLuaBundles(root), expected);

    await buildLuaBundles(root);
    assert.deepEqual(await checkLuaBundles(root), []);
  });
});
