import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLuaBundles, checkLuaBundles } from './lua-bundles.js';

const sources = [
  ['lua/shared/query.lua', 'local function query_common() return "query" end\n'],
  ['lua/shared/recordIdentifier.lua', 'local function record_identifier_common() return "identifier" end\n'],
  ['lua/shared/listQuery.lua', 'local function list_query_common() return "list query" end\n'],
  ['lua/shared/recordView.lua', 'local function record_view_common() return "record" end\n'],
  ['lua/shared/actorView.lua', 'local function actor_view_common() return "actor" end\n'],
  ['lua/shared/location.lua', 'local function query() return "location" end\n'],
  ['lua/shared/actorFollow.lua', 'local function query() return "follow" end\n'],
  ['lua/shared/actorFollowLookup.lua', 'local function lookup() return true end\n'],
  ['lua/shared/actorFollowList.lua', 'local function list() return true end\n'],
  ['lua/shared/profile.lua', 'local function row_view() return "profile" end\n'],
  ['lua/shared/profileLookup.lua', 'local function lookup() return row_view() end\n'],
  ['lua/shared/profileList.lua', 'local function profiles_response() return row_view() end\n'],
  ['lua/src/getLocation.lua', 'function handle() return query() end\n'],
  ['lua/src/listLocations.lua', 'function handle() return query() end\n'],
  ['lua/src/getFollow.lua', 'function handle() return query() end\n'],
  ['lua/src/listActorFollowers.lua', 'function handle() return list() end\n'],
  ['lua/src/listActorFollowing.lua', 'function handle() return list() end\n'],
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

test('checks generated bundles without rewriting stale outputs', async () => {
  await withLuaRoot(async (root) => {
    const expectedStale = [
      'lua/endpoints/getLocation.lua',
      'lua/endpoints/listLocations.lua',
      'lua/endpoints/getFollow.lua',
      'lua/endpoints/listActorFollowers.lua',
      'lua/endpoints/listActorFollowing.lua',
      'lua/endpoints/getProfile.lua',
      'lua/endpoints/listProfiles.lua',
      'lua/endpoints/searchProfiles.lua',
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
      'lua/endpoints/getLocation.lua',
      'lua/endpoints/listLocations.lua',
      'lua/endpoints/getFollow.lua',
      'lua/endpoints/listActorFollowers.lua',
      'lua/endpoints/listActorFollowing.lua',
      'lua/endpoints/getProfile.lua',
      'lua/endpoints/listProfiles.lua',
      'lua/endpoints/searchProfiles.lua',
    ];
    assert.deepEqual(await checkLuaBundles(root), expected);

    await buildLuaBundles(root);
    assert.deepEqual(await checkLuaBundles(root), []);
  });
});
