import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAssets } from './installer.js';
import { validatePackageLexicons } from './validate-lexicons.js';
import {
  actorFollowOrganizationRecords,
  actorFollowProfileRecords,
  actorFollowRecords,
} from '../tests/fixtures/actor-follows.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const actor = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const follower = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const subject = 'did:plc:cccccccccccccccccccccccc';
const followCollection = 'app.certified.graph.follow';
const profileCollection = 'app.certified.actor.profile';
const organizationCollection = 'app.certified.actor.organization';
const indexedAt = '2025-01-02T03:04:05.000Z';

function followRow(id, did, actorDid, createdAt, { subjectDid = actor, via = false } = {}) {
  return {
    uri: `at://${did}/${followCollection}/${id}`,
    did,
    cid: `bafy${id}`,
    indexed_at: indexedAt,
    record: `follow-${id}`,
    actor_did: actorDid,
    sort_timestamp: createdAt.replace('Z', '.000000Z'),
    follow_record: {
      $type: followCollection,
      subject: subjectDid,
      createdAt,
      ...(via ? { via: { uri: 'at://did:plc:list/app.certified.list/one', cid: 'bafylink' } } : {}),
    },
  };
}

function sidecarRow(collection, did, record) {
  return {
    uri: `at://${did}/${collection}/self`, did, cid: `bafy-${collection.endsWith('profile') ? 'profile' : 'org'}-${did.slice(-4)}`,
    indexed_at: indexedAt, record: `sidecar-${collection}-${did}`, sidecar_record: record,
  };
}

function lua(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function cursor({ direction = 'desc', timestamp = '2025-01-02T03:04:05.000000Z', uri = `at://${follower}/${followCollection}/cursor` } = {}) {
  return Buffer.from(JSON.stringify({ v: 1, d: direction, t: timestamp, u: uri }), 'utf8').toString('hex');
}

function runLua({ endpoint, params, rows = [], profiles = [], organizations = [], backend = 'postgres', queryFailure = false, expectError, expectedCalls = 0, assertions }) {
  const endpointPath = `lua/endpoints/${endpoint}.lua`;
  assert.ok(existsSync(`${root}/${endpointPath}`), `${endpointPath} must be generated before exercising the handler`);
  const records = Object.fromEntries([
    ...rows.map(({ record, follow_record }) => [record, follow_record]),
    ...profiles.map(({ record, sidecar_record }) => [record, sidecar_record]),
    ...organizations.map(({ record, sidecar_record }) => [record, sidecar_record]),
  ]);
  const luaSource = `
local NULL_VALUE = {}
local RECORDS = ${lua(records)}
local rows = ${lua(rows)}
local profiles = ${lua(profiles)}
local organizations = ${lua(organizations)}
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
    if RECORDS[value] then return RECORDS[value] end
    if value:sub(1, 1) == '{' then return decode_cursor(value) end
    local decoded = value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
    return decode_cursor(decoded)
  end,
  encode = function(value)
    return string.format('{"v":%d,"d":"%s","t":"%s","u":"%s"}', value.v, value.d, value.t, value.u)
  end,
}
toarray = function(value) return value end
params = ${lua(params)}
db = {
  backend = function() return '${backend}' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if ${queryFailure ? 'true' : 'false'} then error('fixture database failure') end
    if values[1] == '${followCollection}' then return rows end
    if values[1] == '${profileCollection}' then return profiles end
    if values[1] == '${organizationCollection}' then return organizations end
    error('unexpected collection ' .. tostring(values[1]))
  end,
}
dofile('${endpointPath}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected handler to reject the request')\nassert(tostring(result):find('${expectError}', 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected PostgreSQL query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  const result = spawnSync('lua5.4', ['-e', luaSource], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  return result.stdout;
}

test('actor-follow module installs the follow record schema, three queries, and their handlers', async () => {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  assert.ok(manifest.modules.includes('modules/actor-follow/manifest.json'));
  assert.ok(manifest.validationLexicons.some(({ id }) => id === followCollection));

  const { assets } = await loadAssets(`${root}/manifest.json`);
  const expected = [
    followCollection,
    'app.certified.graph.getFollow',
    'app.certified.graph.listActorFollowers',
    'app.certified.graph.listActorFollowing',
    'xrpc.query:app.certified.graph.getFollow',
    'xrpc.query:app.certified.graph.listActorFollowers',
    'xrpc.query:app.certified.graph.listActorFollowing',
  ];
  for (const id of expected) assert.ok(assets.some((asset) => asset.id === id), `missing installed asset ${id}`);
  assert.equal(assets.find((asset) => asset.id === followCollection).config.backfill, true);
  assert.deepEqual(
    assets.filter(({ kind, id }) => kind === 'script' && id.startsWith('xrpc.query:app.certified.graph.')).map(({ id }) => id).sort(),
    expected.filter((id) => id.startsWith('xrpc.query:app.certified.graph.')).sort(),
  );
});

test('actor-follow query Lexicons validate the endpoint inputs, nullable lookup, and shared actor views', async () => {
  const { lexicons, documents } = await validatePackageLexicons();
  const byId = new Map(documents.map((document) => [document.id, document]));
  const follow = byId.get(followCollection);
  const getFollow = byId.get('app.certified.graph.getFollow');
  const followers = byId.get('app.certified.graph.listActorFollowers');
  const following = byId.get('app.certified.graph.listActorFollowing');
  assert.ok(follow && getFollow && followers && following, 'the follow record and all query Lexicons belong to the validation closure');
  assert.equal(lexicons.getDefOrThrow(followCollection).type, 'record');
  assert.deepEqual(Object.keys(getFollow.defs.main.parameters.properties).sort(), ['actor', 'subject']);
  assert.deepEqual(getFollow.defs.output.required, ['follow']);
  assert.deepEqual(getFollow.defs.output.nullable, ['follow']);
  assert.deepEqual(Object.keys(followers.defs.main.parameters.properties).sort(), ['actor', 'cursor', 'limit', 'sortDirection']);
  assert.deepEqual(Object.keys(following.defs.main.parameters.properties).sort(), ['actor', 'cursor', 'limit', 'sortDirection']);
  for (const query of [followers, following]) {
    assert.equal(query.defs.main.parameters.properties.limit.minimum, 1);
    assert.equal(query.defs.main.parameters.properties.limit.maximum, 100);
    assert.equal(query.defs.main.output.encoding, 'application/json');
  }
  const sharedDefinitions = byId.get('org.hypercerts.api.defs');
  const followView = lexicons.getDefOrThrow('app.certified.graph.getFollow#followRecordView');
  const actorFollowView = lexicons.getDefOrThrow('app.certified.graph.getFollow#actorFollowView');
  assert.deepEqual(followView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.equal(followView.properties.record.ref, `lex:${followCollection}`);
  assert.deepEqual(actorFollowView.required, ['did', 'profile', 'organization', 'follow']);
  assert.deepEqual(actorFollowView.nullable, ['profile', 'organization']);
  assert.equal(actorFollowView.properties.profile.ref, 'lex:org.hypercerts.api.defs#profileView');
  assert.equal(actorFollowView.properties.organization.ref, 'lex:org.hypercerts.api.defs#organizationView');
  assert.equal(actorFollowView.properties.follow.ref, 'lex:app.certified.graph.getFollow#followRecordView');
  assert.equal(sharedDefinitions.defs.actorFollowView, undefined);
  assert.equal(followers.defs.output.properties.followers.items.ref, 'lex:app.certified.graph.getFollow#actorFollowView');
  assert.equal(following.defs.output.properties.following.items.ref, 'lex:app.certified.graph.getFollow#actorFollowView');
  const { jsonToLex, lexToJson } = await import('@atproto/lexicon');
  const record = { $type: followCollection, subject, createdAt: '2025-01-01T00:00:00.000Z' };
  const decoded = jsonToLex(record);
  lexicons.assertValidRecord(followCollection, decoded);
  assert.deepEqual(lexToJson(decoded), record);
});

test('actor-follow fixture records validate against their pinned Lexicons', async () => {
  const { lexicons } = await validatePackageLexicons();
  const { jsonToLex, lexToJson } = await import('@atproto/lexicon');
  for (const record of [...actorFollowRecords, ...actorFollowProfileRecords, ...actorFollowOrganizationRecords]) {
    const decoded = jsonToLex(record.record);
    lexicons.assertValidRecord(record.collection, decoded);
    assert.deepEqual(lexToJson(decoded), record.record);
  }
});

test('actor-follow views do not mutate the already-installed shared actor definitions', async () => {
  const { documents } = await validatePackageLexicons();
  const shared = documents.find(({ id }) => id === 'org.hypercerts.api.defs');
  const getFollow = documents.find(({ id }) => id === 'app.certified.graph.getFollow');
  assert.equal(shared.defs.followRecordView, undefined);
  assert.equal(shared.defs.actorFollowView, undefined);
  assert.ok(getFollow.defs.followRecordView && getFollow.defs.actorFollowView);
});

test('getFollow selects one raw representative, preserves via, and returns null for no relationship', () => {
  const earliest = followRow('early', actor, actor, '2025-01-01T00:00:00Z', { subjectDid: subject, via: true });
  const output = runLua({
    endpoint: 'getFollow', params: { actor, subject }, rows: [earliest],
    assertions: `
assert(result.follow.uri == '${earliest.uri}')
assert(result.follow.cid == '${earliest.cid}' and result.follow.indexedAt == '${indexedAt}')
assert(result.follow.did == '${actor}' and result.follow.record.createdAt == '2025-01-01T00:00:00Z')
assert(result.follow.record.via.uri == 'at://did:plc:list/app.certified.list/one')
assert(#calls == 1)
assert(calls[1].values[1] == '${followCollection}' and calls[1].values[2] == '${actor}' and calls[1].values[3] == '${subject}')
assert(calls[1].sql:find("ORDER BY (record::jsonb->>'createdAt')::timestamptz ASC, uri ASC LIMIT 1", 1, true))
assert(result.follow.via == nil, 'via stays inside the unchanged raw record')
`,
  });
  assert.equal(output, '');

  runLua({ endpoint: 'getFollow', params: { actor, subject }, rows: [], assertions: 'assert(result.follow == NULL_VALUE)\nassert(#calls == 1)' });
});

test('listActorFollowers deduplicates before cursor pagination, sorts newest first, and hydrates only the returned page', () => {
  const rows = [
    followRow('follower-a', follower, follower, '2025-01-05T00:00:00Z', { via: true }),
    followRow('follower-b', subject, subject, '2025-01-04T00:00:00Z'),
    followRow('next-page', 'did:plc:dddddddddddddddddddddddd', 'did:plc:dddddddddddddddddddddddd', '2025-01-03T00:00:00Z'),
  ];
  const profile = sidecarRow(profileCollection, follower, { $type: profileCollection, displayName: 'Follower profile' });
  const organization = sidecarRow(organizationCollection, follower, { $type: organizationCollection, visibility: 'public' });
  runLua({
    endpoint: 'listActorFollowers', params: {
      actor, limit: '2', sortDirection: 'desc',
      cursor: cursor({ direction: 'desc', timestamp: '2025-01-06T00:00:00.000000Z' }),
    }, rows, profiles: [profile], organizations: [organization],
    assertions: `
assert(#result.followers == 2 and result.followers[1].did == '${follower}' and result.followers[2].did == '${subject}')
assert(result.followers[1].follow.did == '${follower}' and result.followers[1].follow.record.via.uri ~= nil)
assert(result.followers[1].profile.uri == '${profile.uri}' and result.followers[1].profile.did == '${follower}')
assert(result.followers[1].profile.cid == '${profile.cid}' and result.followers[1].profile.indexedAt == '${indexedAt}')
assert(result.followers[1].profile.record.displayName == 'Follower profile')
assert(result.followers[1].organization.uri == '${organization.uri}')
assert(result.followers[1].organization.cid == '${organization.cid}' and result.followers[1].organization.indexedAt == '${indexedAt}')
assert(result.followers[1].organization.record.visibility == 'public')
assert(result.followers[2].profile == NULL_VALUE and result.followers[2].organization == NULL_VALUE)
assert(result.cursor ~= nil)
local sql = calls[1].sql
assert(sql:find("record::jsonb->>'subject' = $2", 1, true))
assert(not sql:find('did = $2', 1, true), 'followers are selected by subject, not publisher')
assert(sql:find('ROW_NUMBER() OVER', 1, true))
assert(sql:find("PARTITION BY did, record::jsonb->>'subject'", 1, true))
assert(sql:find("ORDER BY (record::jsonb->>'createdAt')::timestamptz ASC, uri ASC", 1, true))
local representativeFilter = assert(sql:find('relationship_rank = 1', 1, true))
local cursorFilter = assert(sql:find('(sort_at, uri) <', 1, true))
assert(representativeFilter < cursorFilter, 'collapse duplicate relationships before applying the page cursor')
assert(sql:find('ORDER BY sort_at DESC, uri DESC', 1, true))
assert(#calls == 3)
assert(calls[1].values[5] == 3, 'fetch one lookahead row after the two-item page')
assert(calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${follower}' and calls[2].values[3] == '${subject}')
assert(calls[2].values[4] == nil, 'do not hydrate the lookahead row')
assert(calls[3].values[1] == '${organizationCollection}' and calls[3].values[2] == '${follower}' and calls[3].values[3] == '${subject}')
assert(calls[3].values[4] == nil, 'do not hydrate the lookahead row')
local tokenJson = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = decode_cursor(tokenJson)
assert(token.v == 1 and token.d == 'desc' and token.t == '2025-01-04T00:00:00.000000Z')
assert(token.u == 'at://${subject}/${followCollection}/follower-b')
`,
  });
});

test('listActorFollowing exposes the followed DID while keeping the publisher DID in the raw record view', () => {
  const row = followRow('outgoing', actor, subject, '2025-01-06T00:00:00Z', { subjectDid: subject });
  const profile = sidecarRow(profileCollection, subject, { $type: profileCollection, displayName: 'Followed profile' });
  runLua({
    endpoint: 'listActorFollowing', params: { actor, sortDirection: 'asc', limit: '1' }, rows: [row], profiles: [profile],
    assertions: `
assert(#result.following == 1 and result.following[1].did == '${subject}')
assert(result.following[1].follow.did == '${actor}' and result.following[1].follow.uri == '${row.uri}')
assert(result.following[1].profile.uri == '${profile.uri}' and result.following[1].organization == NULL_VALUE)
assert(result.cursor == nil)
assert(calls[1].values[1] == '${followCollection}' and calls[1].values[2] == '${actor}')
assert(calls[1].sql:find('did = $2', 1, true) and calls[1].sql:find('subject_did AS actor_did', 1, true))
assert(calls[1].sql:find("ORDER BY sort_at ASC, uri ASC", 1, true))
`,
  });
});

test('actor-follow listing defaults to 25, allows 100, and returns empty arrays without cursors', () => {
  runLua({
    endpoint: 'listActorFollowers', params: { actor }, rows: [],
    assertions: `
assert(#result.followers == 0 and result.cursor == nil)
assert(calls[1].values[3] == 26)
assert(calls[1].sql:find('ORDER BY sort_at DESC, uri DESC', 1, true))
`,
  });
  runLua({
    endpoint: 'listActorFollowing', params: { actor, limit: '100' }, rows: [],
    assertions: 'assert(#result.following == 0 and calls[1].values[3] == 101)',
  });
});

test('actor-follow queries reject invalid DIDs, limits, scalar repetition, unknown keys, and cursors before querying', () => {
  for (const params of [
    { actor: 'alice.example' },
    { actor, limit: '0' },
    { actor, limit: '101' },
    { actor, limit: { repeated: true } },
    { actor, sortDirection: 'sideways' },
    { actor, extra: 'not-supported' },
    { actor, cursor: 'not-hex' },
    { actor, cursor: cursor({ timestamp: '2025-02-30T00:00:00Z' }) },
    { actor, cursor: cursor({ direction: 'asc' }), sortDirection: 'desc' },
  ]) {
    runLua({ endpoint: 'listActorFollowers', params, expectError: 'InvalidRequest:' });
  }
  runLua({ endpoint: 'getFollow', params: { actor, subject: 'alice.example' }, expectError: 'InvalidRequest:' });
});

test('actor-follow queries surface the beta PostgreSQL-only and operational failure errors', () => {
  runLua({ endpoint: 'listActorFollowers', params: { actor }, backend: 'sqlite', expectError: 'ActorFollowQueryFailed:', expectedCalls: 0 });
  runLua({ endpoint: 'listActorFollowers', params: { actor }, queryFailure: true, expectError: 'ActorFollowQueryFailed:', expectedCalls: 1 });
});
