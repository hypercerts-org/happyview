import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const actor = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const author = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const entityUri = `at://${author}/org.hypercerts.entity.feature/feature-one`;
const nextEntityUri = `at://${author}/org.hypercerts.entity.feature/feature-next`;
const entityFollow = 'app.certified.graph.entityFollow';
const featureCollection = 'org.hypercerts.entity.feature';
const profileCollection = 'app.certified.actor.profile';
const organizationCollection = 'app.certified.actor.organization';

function lua(value) {
  if (value === null) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function runLua(endpoint, source) {
  const endpointPath = `${root}/lua/endpoints/${endpoint}.lua`;
  assert.ok(existsSync(endpointPath), `generate the standalone Lua handler before exercising ${endpoint}`);
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
}

test('listEntityFollowing keeps the URI-only target and follow, hydrates only the returned feature page, and emits a nullable indexedAt', () => {
  const follows = [
    {
      uri: `at://${actor}/${entityFollow}/follow-one`, did: actor, cid: 'bafy-follow-one',
      indexed_at: null, record: 'follow-one', sort_timestamp: '2025-01-03T00:00:00.000000Z',
      follow_record: { $type: entityFollow, subject: { uri: entityUri }, createdAt: '2025-01-03T00:00:00Z' },
    },
    {
      uri: `at://${actor}/${entityFollow}/follow-next`, did: actor, cid: 'bafy-follow-next',
      indexed_at: '2025-01-02T00:00:00Z', record: 'follow-next', sort_timestamp: '2025-01-02T00:00:00.000000Z',
      follow_record: { $type: entityFollow, subject: { uri: nextEntityUri }, createdAt: '2025-01-02T00:00:00Z' },
    },
  ];
  const featureRecord = {
    $type: featureCollection, title: 'Protected forest', createdAt: '2025-01-01T00:00:00Z',
    locations: [{ uri: 'at://did:plc:cccccccccccccccccccccccc/app.certified.location/zone', cid: 'bafylocation' }],
    tags: [{ uri: 'at://did:plc:cccccccccccccccccccccccc/org.hypercerts.vocab.tag/forest', cid: 'bafytag' }],
    sameAs: ['https://example.test/forest/one'],
  };
  const feature = {
    uri: entityUri, did: author, cid: 'bafy-feature-one', indexed_at: null,
    record: 'feature-one', feature_record: featureRecord,
  };
  const profile = {
    uri: `at://${author}/${profileCollection}/self`, did: author, cid: 'bafy-profile',
    indexed_at: null, record: 'profile-author', profile_record: { $type: profileCollection, displayName: 'Feature author' },
  };
  const records = Object.fromEntries([
    ...follows.map(({ record, follow_record }) => [record, follow_record]),
    [feature.record, feature.feature_record],
    [profile.record, profile.profile_record],
  ]);
  const expected = {
    actor,
    author,
    entityFollow,
    featureCollection,
    profileCollection,
    organizationCollection,
    entityUri,
    nextEntityUri,
    follows,
    feature,
    profile,
    records,
  };
  const source = `
local NULL_VALUE = {}
local FIXTURE = ${lua(expected)}
local calls = {}
local function decode_cursor(value)
  local version = tonumber(value:match('"v":(%d+)'))
  local direction = value:match('"d":"([^"]*)"')
  local timestamp = value:match('"t":"([^"]*)"')
  local uri = value:match('"u":"([^"]*)"')
  if not version or not direction or not timestamp or not uri then error('invalid cursor JSON') end
  return { v = version, d = direction, t = timestamp, u = uri }
end
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if FIXTURE.records[value] then return FIXTURE.records[value] end
    local decoded = value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
    return decode_cursor(decoded)
  end,
  encode = function(value)
    return string.format('{"v":%d,"d":"%s","t":"%s","u":"%s"}', value.v, value.d, value.t, value.u)
  end,
}
toarray = function(value) return value end
params = { actor = FIXTURE.actor, limit = '1', sortDirection = 'desc' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == FIXTURE.entityFollow then return FIXTURE.follows end
    if values[1] == FIXTURE.featureCollection then return { FIXTURE.feature } end
    if values[1] == FIXTURE.profileCollection then return { FIXTURE.profile } end
    if values[1] == FIXTURE.organizationCollection then return {} end
    error('unexpected query collection ' .. tostring(values[1]))
  end,
}
dofile('lua/endpoints/listEntityFollowing.lua')
local ok, result = pcall(handle)
assert(ok, tostring(result))
assert(#result.entities == 1 and result.cursor ~= nil)
local item = result.entities[1]
assert(item.uri == FIXTURE.entityUri)
assert(item.follow.uri == FIXTURE.follows[1].uri and item.follow.did == FIXTURE.actor)
assert(item.follow.indexedAt == NULL_VALUE, 'a nullable follow indexedAt must remain explicit null')
assert(item.entity['$type'] == 'org.hypercerts.collection.listCollectionItems#featureView')
assert(item.entity.uri == FIXTURE.entityUri and item.entity.indexedAt == NULL_VALUE)
assert(item.entity.author.did == FIXTURE.author)
assert(item.entity.author.profile.record.displayName == 'Feature author')
assert(item.entity.author.profile.indexedAt == NULL_VALUE and item.entity.author.organization == NULL_VALUE)
assert(item.entity.record.title == 'Protected forest')
assert(item.entity.record.locations[1].uri == FIXTURE.feature.feature_record.locations[1].uri)
assert(item.entity.record.tags[1].uri == FIXTURE.feature.feature_record.tags[1].uri)
assert(item.entity.record.sameAs[1] == FIXTURE.feature.feature_record.sameAs[1])
assert(item.entity.location == nil and item.entity.tags == nil, 'feature references remain unexpanded')
assert(#calls == 4, 'only the page target and its two author sidecars should be hydrated')
assert(calls[1].values[1] == FIXTURE.entityFollow and calls[1].values[2] == FIXTURE.actor and calls[1].values[3] == 2)
assert(calls[1].sql:find('did = $2', 1, true), 'actor filter is bound in SQL')
assert(calls[2].values[1] == FIXTURE.featureCollection and calls[2].values[2] == FIXTURE.entityUri)
assert(calls[2].values[2] ~= FIXTURE.nextEntityUri, 'lookahead targets must not be hydrated')
assert(calls[3].values[1] == FIXTURE.profileCollection and calls[3].values[2] == FIXTURE.author)
assert(calls[4].values[1] == FIXTURE.organizationCollection and calls[4].values[2] == FIXTURE.author)
local token_json = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = decode_cursor(token_json)
assert(token.v == 1 and token.d == 'desc' and token.t == '2025-01-03T00:00:00.000000Z')
assert(token.u == FIXTURE.follows[1].uri)
`;
  runLua('listEntityFollowing', source);
});

test('entity-follow listing selects earliest representatives before direction-bound cursor pagination', () => {
  const followerA = 'did:plc:cccccccccccccccccccccccc';
  const followerB = 'did:plc:dddddddddddddddddddddddd';
  const followedEntity = 'at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.entity.feature/target';
  const cases = [
    {
      direction: 'desc', operator: '<', ordering: 'DESC', cursorAt: '2025-01-04T00:00:00.000000Z',
      cursorUri: `at://${actor}/${entityFollow}/cursor-desc`,
      rows: [
        { did: followerA, key: 'earliest', createdAt: '2025-01-03T00:00:00Z', timestamp: '2025-01-03T00:00:00.000000Z' },
        { did: followerB, key: 'desc-next', createdAt: '2025-01-02T00:00:00Z', timestamp: '2025-01-02T00:00:00.000000Z' },
      ],
    },
    {
      direction: 'asc', operator: '>', ordering: 'ASC', cursorAt: '2024-12-31T00:00:00.000000Z',
      cursorUri: `at://${actor}/${entityFollow}/cursor-asc`,
      rows: [
        { did: followerB, key: 'asc-first', createdAt: '2025-01-01T00:00:00Z', timestamp: '2025-01-01T00:00:00.000000Z' },
        { did: followerA, key: 'asc-next', createdAt: '2025-01-02T00:00:00Z', timestamp: '2025-01-02T00:00:00.000000Z' },
      ],
    },
  ];

  for (const scenario of cases) {
    const follows = scenario.rows.map(({ did, key, createdAt, timestamp }) => ({
      uri: `at://${did}/${entityFollow}/${key}`, did, cid: `bafy-${key}`,
      indexed_at: '2025-01-05T00:00:00Z', record: key, sort_timestamp: timestamp,
      follow_record: { $type: entityFollow, subject: { uri: followedEntity }, createdAt },
    }));
    const records = Object.fromEntries(follows.map(({ record, follow_record }) => [record, follow_record]));
    const encodedCursor = Buffer.from(JSON.stringify({ v: 1, d: scenario.direction, t: scenario.cursorAt, u: scenario.cursorUri }), 'utf8').toString('hex');
    const source = `
local FIXTURE = ${lua({ entityFollow, profileCollection, organizationCollection, followedEntity, follows, records })}
local NULL_VALUE = {}
local calls = {}
local function decode_cursor(value)
  local version = tonumber(value:match('"v":(%d+)'))
  local direction = value:match('"d":"([^"]*)"')
  local timestamp = value:match('"t":"([^"]*)"')
  local uri = value:match('"u":"([^"]*)"')
  if not version or not direction or not timestamp or not uri then error('invalid cursor JSON') end
  return { v = version, d = direction, t = timestamp, u = uri }
end
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if FIXTURE.records[value] then return FIXTURE.records[value] end
    if value:sub(1, 1) == '{' then return decode_cursor(value) end
    local decoded = value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
    return decode_cursor(decoded)
  end,
  encode = function(value)
    return string.format('{"v":%d,"d":"%s","t":"%s","u":"%s"}', value.v, value.d, value.t, value.u)
  end,
}
toarray = function(value) return value end
params = { entity = FIXTURE.followedEntity, limit = '1', sortDirection = '${scenario.direction}', cursor = '${encodedCursor}' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == FIXTURE.entityFollow then return FIXTURE.follows end
    if values[1] == FIXTURE.profileCollection or values[1] == FIXTURE.organizationCollection then return {} end
    error('unexpected query collection ' .. tostring(values[1]))
  end,
}
dofile('lua/endpoints/listEntityFollowers.lua')
local ok, result = pcall(handle)
assert(ok, tostring(result))
assert(#result.followers == 1 and result.cursor ~= nil and result.totalCount == nil)
assert(result.followers[1].did == '${scenario.rows[0].did}')
assert(result.followers[1].follow.record.createdAt == '${scenario.rows[0].createdAt}')
local sql = calls[1].sql
assert(calls[1].values[1] == FIXTURE.entityFollow and calls[1].values[2] == FIXTURE.followedEntity)
assert(calls[1].values[3] == '${scenario.cursorAt}' and calls[1].values[4] == '${scenario.cursorUri}' and calls[1].values[5] == 2)
assert(sql:find("record::jsonb->'subject'->>'uri' = $2", 1, true), 'filter by the bound entity URI')
assert(sql:find("PARTITION BY did, record::jsonb->'subject'->>'uri'", 1, true))
assert(sql:find('ROW_NUMBER() OVER', 1, true))
assert(sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true), 'choose the earliest duplicate independently of result direction')
assert(sql:find("jsonb_typeof(record::jsonb->'createdAt') = 'string'", 1, true))
assert(sql:find('ELSE COALESCE(indexed_at::timestamptz, created_at::timestamptz) END', 1, true))
local representative = assert(sql:find('relationship_rank = 1', 1, true))
local cursor_filter = assert(sql:find('(sort_at, uri) ${scenario.operator}', 1, true))
assert(representative < cursor_filter, 'apply the cursor only after representative selection')
assert(sql:find('ORDER BY sort_at ${scenario.ordering}, uri ${scenario.ordering}', 1, true))
local token_json = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = decode_cursor(token_json)
assert(token.v == 1 and token.d == '${scenario.direction}' and token.t == '${scenario.rows[0].timestamp}')
assert(token.u == 'at://${scenario.rows[0].did}/${entityFollow}/${scenario.rows[0].key}')
`;
    runLua('listEntityFollowers', source);
  }
});

test('entity-follow cursors reject a different direction, another collection, and invalid timestamps before querying', () => {
  const source = `
local NULL_VALUE, active_cursor, calls = {}, nil, 0
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    return active_cursor
  end,
}
toarray = function(value) return value end
db = {
  backend = function() return 'postgres' end,
  raw = function() calls = calls + 1; return {} end,
}
dofile('lua/endpoints/listEntityFollowing.lua')
for _, invalid_cursor in ipairs({
  { v = 1, d = 'asc', t = '2025-01-01T00:00:00Z', u = 'at://${actor}/${entityFollow}/cursor' },
  { v = 1, d = 'desc', t = '2025-01-01T00:00:00Z', u = 'at://${actor}/app.certified.graph.follow/cursor' },
  { v = 1, d = 'desc', t = 'not-a-datetime', u = 'at://${actor}/${entityFollow}/cursor' },
}) do
  active_cursor = invalid_cursor
  params = { actor = '${actor}', sortDirection = 'desc', cursor = '00' }
  local ok, result = pcall(handle)
  assert(not ok and tostring(result):find('InvalidRequest:', 1, true), tostring(result))
end
assert(calls == 0, 'invalid cursors are rejected before database access')
`;
  runLua('listEntityFollowing', source);
});

test('getEntityFollow returns the earliest raw relationship or explicit null without hydrating its target', () => {
  const entity = 'at://did:plc:cccccccccccccccccccccccc/org.example.unsupported/key';
  const row = {
    uri: `at://${actor}/${entityFollow}/earliest`, did: actor, cid: 'bafy-earliest', indexed_at: null,
    record: 'raw-follow', follow_record: { $type: entityFollow, subject: { uri: entity }, createdAt: '2025-01-01T00:00:00Z' },
  };
  const source = `
local NULL_VALUE = {}
local follow = ${lua(row)}
local calls, found = {}, true
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if value == 'raw-follow' then return follow.follow_record end
    error('unexpected JSON decode input ' .. tostring(value))
  end,
}
params = { actor = '${actor}', entity = '${entity}' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if found then return { follow } end
    return {}
  end,
}
dofile('lua/endpoints/getEntityFollow.lua')
local ok, result = pcall(handle)
assert(ok, tostring(result))
assert(result.follow.uri == follow.uri and result.follow.did == '${actor}')
assert(result.follow.indexedAt == NULL_VALUE and result.follow.record.subject.uri == '${entity}')
assert(#calls == 1 and calls[1].values[1] == '${entityFollow}')
assert(calls[1].values[2] == '${actor}' and calls[1].values[3] == '${entity}')
assert(calls[1].sql:find("record::jsonb->'subject'->>'uri' = $3", 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, uri ASC LIMIT 1', 1, true))
found = false
ok, result = pcall(handle)
assert(ok and result.follow == NULL_VALUE, tostring(result))
assert(#calls == 2, 'singular lookup returns the raw relationship without target or actor hydration')
`;
  runLua('getEntityFollow', source);
});

test('listEntityFollowers preserves follower identity and hydrates profiles and organization sidecars for the page only', () => {
  const follower = 'did:plc:cccccccccccccccccccccccc';
  const lookahead = 'did:plc:dddddddddddddddddddddddd';
  const entity = 'at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.entity.feature/target';
  const follows = [
    { uri: `at://${follower}/${entityFollow}/incoming`, did: follower, cid: 'bafy-incoming', indexed_at: null, record: 'follow-incoming', sort_timestamp: '2025-01-03T00:00:00.000000Z', follow_record: { $type: entityFollow, subject: { uri: entity }, createdAt: '2025-01-03T00:00:00Z' } },
    { uri: `at://${lookahead}/${entityFollow}/lookahead`, did: lookahead, cid: 'bafy-lookahead', indexed_at: '2025-01-02T00:00:00Z', record: 'follow-lookahead', sort_timestamp: '2025-01-02T00:00:00.000000Z', follow_record: { $type: entityFollow, subject: { uri: entity }, createdAt: '2025-01-02T00:00:00Z' } },
  ];
  const profile = { uri: `at://${follower}/${profileCollection}/self`, did: follower, cid: 'bafy-incoming-profile', indexed_at: '2025-01-01T00:00:00Z', record: 'incoming-profile', sidecar_record: { $type: profileCollection, displayName: 'Incoming follower' } };
  const organization = { uri: `at://${follower}/${organizationCollection}/self`, did: follower, cid: 'bafy-incoming-org', indexed_at: '2025-01-01T00:00:00Z', record: 'incoming-org', sidecar_record: { $type: organizationCollection, organizationType: ['nonprofit'] } };
  const records = Object.fromEntries([
    ...follows.map(({ record, follow_record }) => [record, follow_record]),
    [profile.record, profile.sidecar_record],
    [organization.record, organization.sidecar_record],
  ]);
  const source = `
local FIXTURE = ${lua({ entityFollow, profileCollection, organizationCollection, entity, follows, profile, organization, records })}
local NULL_VALUE = {}
local calls = {}
local function decode_cursor(value)
  local version = tonumber(value:match('"v":(%d+)'))
  local direction = value:match('"d":"([^"]*)"')
  local timestamp = value:match('"t":"([^"]*)"')
  local uri = value:match('"u":"([^"]*)"')
  if not version or not direction or not timestamp or not uri then error('invalid cursor JSON') end
  return { v = version, d = direction, t = timestamp, u = uri }
end
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if FIXTURE.records[value] then return FIXTURE.records[value] end
    if value:sub(1, 1) == '{' then return decode_cursor(value) end
    local decoded = value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
    return decode_cursor(decoded)
  end,
  encode = function(value)
    return string.format('{"v":%d,"d":"%s","t":"%s","u":"%s"}', value.v, value.d, value.t, value.u)
  end,
}
toarray = function(value) return value end
params = { entity = FIXTURE.entity, limit = '1' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == FIXTURE.entityFollow then return FIXTURE.follows end
    if values[1] == FIXTURE.profileCollection then return { FIXTURE.profile } end
    if values[1] == FIXTURE.organizationCollection then return { FIXTURE.organization } end
    error('unexpected query collection ' .. tostring(values[1]))
  end,
}
dofile('lua/endpoints/listEntityFollowers.lua')
local ok, result = pcall(handle)
assert(ok, tostring(result))
assert(#result.followers == 1 and result.cursor ~= nil and result.totalCount == nil)
local item = result.followers[1]
assert(item.did == FIXTURE.follows[1].did and item.follow.did == FIXTURE.follows[1].did)
assert(item.follow.indexedAt == NULL_VALUE and item.follow.uri == FIXTURE.follows[1].uri)
assert(item.profile.did == FIXTURE.follows[1].did and item.profile.record.displayName == 'Incoming follower')
assert(item.organization.did == FIXTURE.follows[1].did and item.organization.record.organizationType[1] == 'nonprofit')
assert(#calls == 3)
assert(calls[1].values[1] == FIXTURE.entityFollow and calls[1].values[2] == FIXTURE.entity)
assert(calls[1].sql:find("record::jsonb->'subject'->>'uri' = $2", 1, true))
assert(calls[2].values[1] == FIXTURE.profileCollection and calls[2].values[2] == FIXTURE.follows[1].did and calls[2].values[3] == nil)
assert(calls[3].values[1] == FIXTURE.organizationCollection and calls[3].values[2] == FIXTURE.follows[1].did and calls[3].values[3] == nil)
local token_json = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = decode_cursor(token_json)
assert(token.u == FIXTURE.follows[1].uri and token.d == 'desc')
`;
  runLua('listEntityFollowers', source);
});

test('listEntityFollowing returns hydrated ActivityView and CollectionView unions without expanding collection items', () => {
  const activityDid = 'did:plc:cccccccccccccccccccccccc';
  const collectionDid = 'did:plc:dddddddddddddddddddddddd';
  const activityCollection = 'org.hypercerts.claim.activity';
  const collectionCollection = 'org.hypercerts.collection';
  const activityUri = `at://${activityDid}/${activityCollection}/activity-one`;
  const collectionUri = `at://${collectionDid}/${collectionCollection}/collection-one`;
  const rawCollection = {
    $type: collectionCollection, title: 'Root collection', createdAt: '2025-01-01T00:00:00Z',
    items: [{ itemIdentifier: { uri: activityUri, cid: 'bafy-item-version' }, itemWeight: '1' }],
  };
  const follows = [
    { uri: `at://${actor}/${entityFollow}/activity-follow`, did: actor, cid: 'bafy-fa', indexed_at: null, record: 'follow-activity', sort_timestamp: '2025-01-03T00:00:00.000000Z', follow_record: { $type: entityFollow, subject: { uri: activityUri }, createdAt: '2025-01-03T00:00:00Z' } },
    { uri: `at://${actor}/${entityFollow}/collection-follow`, did: actor, cid: 'bafy-fc', indexed_at: null, record: 'follow-collection', sort_timestamp: '2025-01-02T00:00:00.000000Z', follow_record: { $type: entityFollow, subject: { uri: collectionUri }, createdAt: '2025-01-02T00:00:00Z' } },
  ];
  const activity = { uri: activityUri, did: activityDid, cid: 'bafy-activity-latest', indexed_at: null, record: 'activity-record', target_record: { $type: activityCollection, title: 'Resolved activity', createdAt: '2025-01-01T00:00:00Z' } };
  const collection = { uri: collectionUri, did: collectionDid, cid: 'bafy-collection-latest', indexed_at: null, record: 'collection-record', target_record: rawCollection };
  const records = Object.fromEntries([
    ...follows.map(({ record, follow_record }) => [record, follow_record]),
    [activity.record, activity.target_record], [collection.record, collection.target_record],
  ]);
  const source = `
local NULL_VALUE = {}
local FIXTURE = ${lua({ entityFollow, activityCollection, collectionCollection, featureCollection, profileCollection, organizationCollection, activityUri, collectionUri, follows, activity, collection, records })}
local calls = {}
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if FIXTURE.records[value] then return FIXTURE.records[value] end
    error('unexpected JSON decode input ' .. tostring(value))
  end,
}
toarray = function(value) return value end
params = { actor = '${actor}', limit = '2' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == FIXTURE.entityFollow then return FIXTURE.follows end
    if values[1] == FIXTURE.activityCollection then return { FIXTURE.activity } end
    if values[1] == FIXTURE.collectionCollection then return { FIXTURE.collection } end
    if values[1] == FIXTURE.profileCollection or values[1] == FIXTURE.organizationCollection then return {} end
    error('unexpected query collection ' .. tostring(values[1]))
  end,
}
dofile('lua/endpoints/listEntityFollowing.lua')
local ok, result = pcall(handle)
assert(ok, tostring(result))
assert(#result.entities == 2 and result.cursor == nil)
local activity_item, collection_item = result.entities[1], result.entities[2]
assert(activity_item.entity['$type'] == 'org.hypercerts.claim.getActivity#activityView')
assert(activity_item.uri == FIXTURE.activityUri and activity_item.entity.uri == FIXTURE.activityUri)
assert(activity_item.entity.cid == 'bafy-activity-latest' and activity_item.entity.indexedAt == NULL_VALUE)
assert(activity_item.entity.record.title == 'Resolved activity' and activity_item.entity.author.did == FIXTURE.activity.did)
assert(activity_item.follow.uri == FIXTURE.follows[1].uri)
assert(collection_item.entity['$type'] == 'org.hypercerts.collection.getCollection#collectionView')
assert(collection_item.uri == FIXTURE.collectionUri and collection_item.entity.uri == FIXTURE.collectionUri)
assert(collection_item.entity.cid == 'bafy-collection-latest' and collection_item.entity.indexedAt == NULL_VALUE)
assert(collection_item.entity.record.items[1].itemIdentifier.uri == FIXTURE.activityUri)
assert(collection_item.entity.items == nil, 'collection hydration does not expand embedded items')
assert(collection_item.follow.uri == FIXTURE.follows[2].uri)
assert(calls[2].values[1] == FIXTURE.activityCollection and calls[2].values[2] == FIXTURE.activityUri)
assert(calls[5].values[1] == FIXTURE.collectionCollection and calls[5].values[2] == FIXTURE.collectionUri)
assert(calls[2].values[3] == nil and calls[5].values[3] == nil, 'target resolution binds URI, not a pinned CID')
for _, target_call in ipairs({ calls[2], calls[5] }) do
  assert(target_call.sql:find('SELECT DISTINCT ON (uri)', 1, true), 'choose the latest indexed row per followed URI')
  assert(target_call.sql:find('ORDER BY uri, COALESCE(indexed_at::timestamptz, created_at::timestamptz) DESC', 1, true))
end
`;
  runLua('listEntityFollowing', source);
});

test('listEntityFollowing preserves unresolved targets as null and propagates database and hydration failures', () => {
  const featureUri = `at://${author}/org.hypercerts.entity.feature/maybe-missing`;
  const unsupportedUri = `at://${author}/org.example.unsupported/record`;
  const follows = {
    missing: { uri: `at://${actor}/${entityFollow}/missing`, did: actor, cid: 'bafy-missing-follow', indexed_at: null, record: 'follow-missing', follow_record: { $type: entityFollow, subject: { uri: featureUri }, createdAt: '2025-01-03T00:00:00Z' } },
    unsupported: { uri: `at://${actor}/${entityFollow}/unsupported`, did: actor, cid: 'bafy-unsupported-follow', indexed_at: null, record: 'follow-unsupported', follow_record: { $type: entityFollow, subject: { uri: unsupportedUri }, createdAt: '2025-01-02T00:00:00Z' } },
  };
  const featureRecord = { $type: featureCollection, title: 'Indexed feature', createdAt: '2025-01-01T00:00:00Z' };
  const feature = { uri: featureUri, did: author, cid: 'bafy-feature', indexed_at: null, record: 'feature-target', feature_record: featureRecord };
  const records = Object.fromEntries([
    ...Object.values(follows).map(({ record, follow_record }) => [record, follow_record]),
    [feature.record, feature.feature_record],
  ]);
  const source = `
local NULL_VALUE = {}
local FIXTURE = ${lua({ actor, author, entityFollow, featureCollection, profileCollection, organizationCollection, featureUri, unsupportedUri, follows, feature, records })}
local calls, active_mode = {}, nil
json = {
  decode = function(value)
    if value == 'null' then return NULL_VALUE end
    if FIXTURE.records[value] then return FIXTURE.records[value] end
    error('unexpected JSON decode input ' .. tostring(value))
  end,
}
toarray = function(value) return value end
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == FIXTURE.entityFollow then
      if active_mode == 'primary-failure' then error('injected primary failure') end
      return { active_mode == 'unsupported' and FIXTURE.follows.unsupported or FIXTURE.follows.missing }
    end
    if values[1] == FIXTURE.featureCollection then
      if active_mode == 'target-failure' then error('injected target failure') end
      if active_mode == 'missing' then return {} end
      return { FIXTURE.feature }
    end
    if values[1] == FIXTURE.profileCollection then
      if active_mode == 'hydration-failure' then error('injected profile failure') end
      return {}
    end
    if values[1] == FIXTURE.organizationCollection then return {} end
    error('unexpected query collection ' .. tostring(values[1]))
  end,
}
dofile('lua/endpoints/listEntityFollowing.lua')
local function invoke(mode)
  active_mode = mode
  for index in pairs(calls) do calls[index] = nil end
  params = { actor = FIXTURE.actor, limit = '1' }
  return pcall(handle)
end
for _, mode in ipairs({ 'missing', 'unsupported' }) do
  local ok, result = invoke(mode)
  assert(ok, tostring(result))
  assert(#result.entities == 1 and result.entities[1].entity == NULL_VALUE and result.cursor == nil)
  assert(result.entities[1].uri == result.entities[1].follow.record.subject.uri)
  assert(result.entities[1].follow.uri ~= nil, 'unresolved targets retain the raw relationship')
  assert(#calls == (mode == 'missing' and 2 or 1), 'unsupported targets do not trigger target hydration')
end
for _, mode in ipairs({ 'primary-failure', 'target-failure', 'hydration-failure' }) do
  local ok, result = invoke(mode)
  assert(not ok, 'operational failure must not return an empty or partial page')
  local expected = mode == 'hydration-failure' and 'CollectionQueryFailed:' or 'EntityFollowQueryFailed:'
  assert(tostring(result):find(expected, 1, true), tostring(result))
end
`;
  runLua('listEntityFollowing', source);
});

test('entity-follow module installs its pinned record and query closure without adding unrelated graph APIs', async () => {
  const rootManifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  const modulePath = 'modules/entity-follow/manifest.json';
  assert.ok(rootManifest.modules.includes(modulePath));

  const moduleManifest = JSON.parse(await readFile(`${root}/${modulePath}`, 'utf8'));
  const moduleIds = moduleManifest.assets.map(({ id }) => id).sort();
  assert.deepEqual(moduleIds, [
    'app.certified.graph.entityFollow',
    'app.certified.graph.getEntityFollow',
    'app.certified.graph.listEntityFollowers',
    'app.certified.graph.listEntityFollowing',
    'xrpc.query:app.certified.graph.getEntityFollow',
    'xrpc.query:app.certified.graph.listEntityFollowers',
    'xrpc.query:app.certified.graph.listEntityFollowing',
  ].sort());

  const moduleManifests = await Promise.all(rootManifest.modules.map(async (path) =>
    JSON.parse(await readFile(resolve(root, path), 'utf8'))));
  const assets = moduleManifests.flatMap(({ assets: moduleAssets }) => moduleAssets);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  assert.equal(assetsById.size, assets.length, 'each installable asset has one owning module');
  for (const asset of assets) {
    for (const dependency of asset.dependsOn ?? []) {
      assert.ok(assetsById.has(dependency), `${asset.id} depends on an asset outside the install bundle: ${dependency}`);
    }
  }

  const record = assetsById.get('app.certified.graph.entityFollow');
  assert.equal(record.config.backfill, true);
  assert.deepEqual(record.dependsOn, ['app.certified.signature.defs']);
  const following = assetsById.get('app.certified.graph.listEntityFollowing');
  for (const viewOwner of [
    'org.hypercerts.claim.getActivity',
    'org.hypercerts.collection.getCollection',
    'org.hypercerts.collection.listCollectionItems',
  ]) assert.ok(following.dependsOn.includes(viewOwner));

  const expectedValidationIds = [
    'app.certified.defs',
    'app.certified.graph.entityFollow',
    'app.certified.graph.getEntityFollow',
    'app.certified.graph.listEntityFollowers',
    'app.certified.graph.listEntityFollowing',
    'app.certified.signature.defs',
    'com.atproto.repo.strongRef',
    'org.hypercerts.api.defs',
    'org.hypercerts.claim.getActivity',
    'org.hypercerts.collection.getCollection',
    'org.hypercerts.collection.listCollectionItems',
    'org.hypercerts.entity.feature',
  ];
  const validationSources = new Map(rootManifest.validationLexicons.map((source) => [source.id, source]));
  for (const id of expectedValidationIds) assert.ok(validationSources.has(id), `missing schema validation dependency ${id}`);
  assert.equal(validationSources.get('app.certified.graph.entityFollow').packagePath, 'lexicons/app/certified/graph/entityFollow.json');
  assert.equal(validationSources.get('app.certified.defs').packagePath, 'lexicons/app/certified/defs.json');

  const localLexicons = new Map();
  for (const source of rootManifest.validationLexicons.filter(({ path }) => path)) {
    const document = JSON.parse(await readFile(resolve(root, source.path), 'utf8'));
    assert.equal(document.id, source.id);
    localLexicons.set(document.id, document);
  }
  const apiDefs = localLexicons.get('org.hypercerts.api.defs');
  assert.deepEqual(apiDefs.defs.profileView.nullable, ['indexedAt']);
  assert.deepEqual(apiDefs.defs.organizationView.nullable, ['indexedAt']);
  assert.deepEqual(apiDefs.defs.entityFollowRecordView.nullable, ['indexedAt']);
  assert.ok(apiDefs.defs.entityFollowerView);
  assert.deepEqual(apiDefs.defs.entityFollowerView.nullable, ['profile', 'organization']);
  const followingItem = apiDefs.defs.entityFollowingItem;
  assert.deepEqual(followingItem.properties.entity.refs, [
    'org.hypercerts.claim.getActivity#activityView',
    'org.hypercerts.collection.getCollection#collectionView',
    'org.hypercerts.collection.listCollectionItems#featureView',
  ]);
  for (const id of [
    'app.certified.graph.getEntityFollow',
    'app.certified.graph.listEntityFollowers',
    'app.certified.graph.listEntityFollowing',
  ]) {
    const asset = assetsById.get(id);
    const source = JSON.parse(await readFile(resolve(`${root}/modules/entity-follow`, asset.path), 'utf8'));
    assert.equal(source.id, id);
    assert.equal(asset.config.backfill, false);
  }
  const get = localLexicons.get('app.certified.graph.getEntityFollow');
  const followers = localLexicons.get('app.certified.graph.listEntityFollowers');
  const followingDoc = localLexicons.get('app.certified.graph.listEntityFollowing');
  assert.deepEqual(Object.keys(get.defs.main.parameters.properties).sort(), ['actor', 'entity']);
  assert.deepEqual(get.defs.output.required, ['follow']);
  assert.deepEqual(get.defs.output.nullable, ['follow']);
  for (const [document, outputKey] of [[followers, 'followers'], [followingDoc, 'entities']]) {
    assert.equal(document.defs.main.parameters.properties.limit.minimum, 1);
    assert.equal(document.defs.main.parameters.properties.limit.maximum, 100);
    assert.deepEqual(document.defs.output.required, [outputKey]);
    assert.equal(Object.hasOwn(document.defs.output.properties, 'totalCount'), false);
  }
});

test('listEntityFollowing names unknown query parameters in InvalidRequest diagnostics', () => {
  const source = `
local NULL_VALUE = {}
json = { decode = function(value) if value == 'null' then return NULL_VALUE end return {} end }
toarray = function(values) return values end
params = { actor = '${actor}', bogus = '1' }
local calls = 0
db = {
  backend = function() return 'postgres' end,
  raw = function() calls = calls + 1; return {} end,
}
dofile('lua/endpoints/listEntityFollowing.lua')
local ok, result = pcall(handle)
assert(not ok)
assert(tostring(result) == 'InvalidRequest: unknown query parameter: bogus', tostring(result))
assert(calls == 0, 'unknown parameters must be rejected before database access')
`;
  runLua('listEntityFollowing', source);
});
