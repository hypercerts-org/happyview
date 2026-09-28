import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const organizationCollection = 'app.certified.actor.organization';
const profileCollection = 'app.certified.actor.profile';
const actor = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const secondActor = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const indexedAt = '2025-01-02T03:04:05.000Z';

function lua(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function organizationRow(did, id, record, sortTimestamp = '2025-01-01T00:00:00.000000Z') {
  return {
    uri: `at://${did}/${organizationCollection}/self`, did, cid: `bafy-${id}`, indexed_at: indexedAt,
    record: id, record_json: { $type: organizationCollection, ...record }, sort_timestamp: sortTimestamp,
  };
}

function profileRow(did, id, record) {
  return {
    uri: `at://${did}/${profileCollection}/self`, did, cid: `bafy-${id}`, indexed_at: indexedAt,
    record: id, record_json: { $type: profileCollection, ...record },
  };
}

function cursor({ direction = 'desc', timestamp = '2025-01-02T03:04:05.000000Z', uri = `at://${actor}/${organizationCollection}/self` } = {}) {
  return Buffer.from(JSON.stringify({ v: 1, d: direction, t: timestamp, u: uri }), 'utf8').toString('hex');
}

function runLua({ endpoint, params, queryResults = [], backend = 'postgres', queryFailureAt = 0, expectError, expectedCalls = 0, assertions }) {
  const endpointPath = `lua/endpoints/${endpoint}.lua`;
  assert.ok(existsSync(`${root}/${endpointPath}`), `${endpointPath} must be generated before exercising the handler`);
  const records = Object.fromEntries(queryResults.flat().map((row) => [row.record, row.record_json]));
  const rows = queryResults.map((result) => result.map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'record_json'),
  )));
  const source = `
local RECORDS = ${lua(records)}
local RESULTS = ${lua(rows)}
local NULL = {}
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
    if value == 'null' then return NULL end
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
    if ${queryFailureAt || 0} == #calls then error('fixture database failure') end
    return RESULTS[#calls] or {}
  end,
}
dofile('${endpointPath}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected handler to reject the request')\nassert(tostring(result):find(${JSON.stringify(expectError)}, 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected organization query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
}

test('organization module registers get, list, and search queries with a local validation closure', async () => {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  const modulePath = 'modules/organization/manifest.json';
  assert.ok(manifest.modules.includes(modulePath));
  assert.deepEqual({
    getOrganization: manifest.handlerStatus.getOrganization,
    listOrganizations: manifest.handlerStatus.listOrganizations,
    searchOrganizations: manifest.handlerStatus.searchOrganizations,
  }, {
    getOrganization: 'implemented', listOrganizations: 'implemented', searchOrganizations: 'implemented',
  });

  const module = JSON.parse(await readFile(`${root}/${modulePath}`, 'utf8'));
  const queries = module.assets.filter(({ kind, id }) => kind === 'lexicon' && id.startsWith('app.certified.actor.'));
  assert.deepEqual(queries.map(({ id }) => id).sort(), [
    'app.certified.actor.getOrganization',
    'app.certified.actor.listOrganizations',
    'app.certified.actor.searchOrganizations',
  ]);
  for (const name of ['getOrganization', 'listOrganizations', 'searchOrganizations']) {
    const nsid = `app.certified.actor.${name}`;
    const script = module.assets.find(({ id }) => id === `xrpc.query:${nsid}`);
    assert.ok(script, `missing handler declaration for ${nsid}`);
    assert.equal(script.sourcePath, `../../lua/src/${name}.lua`);
    assert.ok(existsSync(`${root}/lua/endpoints/${name}.lua`), `missing generated handler for ${nsid}`);
    assert.ok(manifest.validationLexicons.some(({ id }) => id === nsid), `missing validation Lexicon ${nsid}`);
  }
});

test('organization Lexicons expose the approved filters, named wrappers, nullable profile, and no founding-date parameters', async () => {
  const getOrganization = JSON.parse(await readFile(`${root}/lexicons/app.certified.actor.getOrganization.json`, 'utf8'));
  const listOrganizations = JSON.parse(await readFile(`${root}/lexicons/app.certified.actor.listOrganizations.json`, 'utf8'));
  const searchOrganizations = JSON.parse(await readFile(`${root}/lexicons/app.certified.actor.searchOrganizations.json`, 'utf8'));
  const getParams = getOrganization.defs.main.parameters;
  assert.deepEqual(getParams.required, ['actor']);
  assert.equal(getParams.properties.actor.format, 'did');
  const actorView = getOrganization.defs.organizationActorView;
  assert.deepEqual(actorView.required, ['did', 'profile', 'organization']);
  assert.deepEqual(actorView.nullable, ['profile']);
  assert.equal(actorView.properties.organization.ref, 'org.hypercerts.api.defs#organizationView');
  assert.equal(getOrganization.defs.output.properties.actor.ref, '#organizationActorView');

  const expectedListingParams = ['actors', 'cursor', 'limit', 'organizationTypes', 'sortDirection', 'visibility'];
  assert.deepEqual(Object.keys(listOrganizations.defs.main.parameters.properties).sort(), expectedListingParams);
  assert.deepEqual(Object.keys(searchOrganizations.defs.main.parameters.properties).sort(), [...expectedListingParams, 'search'].sort());
  assert.deepEqual(searchOrganizations.defs.main.parameters.required, ['search']);
  for (const query of [listOrganizations, searchOrganizations]) {
    const properties = query.defs.main.parameters.properties;
    assert.equal(properties.actors.maxLength, 100);
    assert.equal(properties.organizationTypes.maxLength, 100);
    assert.equal(properties.sortDirection.enum.join(','), 'asc,desc');
    assert.equal(properties.limit.minimum, 1);
    assert.equal(properties.limit.maximum, 100);
    assert.match(properties.limit.description, /default 25/i);
    assert.equal(query.defs.output.properties.actors.items.ref, 'app.certified.actor.getOrganization#organizationActorView');
  }
});

test('getOrganization returns the complete sidecar and an explicit null when its profile is missing', () => {
  const organization = organizationRow(actor, 'org', { organizationType: ['nonprofit'], createdAt: '2025-01-01T00:00:00Z' });
  runLua({
    endpoint: 'getOrganization', params: { actor }, queryResults: [[organization], []],
    assertions: `
assert(result.actor.did == '${actor}')
assert(result.actor.profile == NULL)
assert(result.actor.organization.uri == '${organization.uri}' and result.actor.organization.cid == '${organization.cid}')
assert(result.actor.organization.indexedAt == '${indexedAt}' and result.actor.organization.did == '${actor}')
assert(result.actor.organization.record['$type'] == '${organizationCollection}')
assert(result.actor.organization.record.organizationType[1] == 'nonprofit')
assert(#calls == 2 and calls[1].values[1] == '${organizationCollection}' and calls[1].values[2] == '${actor}')
assert(calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${actor}')
`,
  });
});

test('listOrganizations sorts both tuple fields, filters before pagination, and hydrates only the returned page', () => {
  const first = organizationRow(actor, 'first', { organizationType: ['nonprofit'], visibility: 'unlisted', createdAt: '2025-01-01T00:00:00Z' });
  const lookahead = organizationRow(secondActor, 'lookahead', { organizationType: ['community'], createdAt: '2025-01-02T00:00:00Z' }, '2025-01-02T00:00:00.000000Z');
  const profile = profileRow(actor, 'profile', { displayName: 'Forest Alliance', createdAt: '2025-01-01T00:00:00Z' });
  runLua({
    endpoint: 'listOrganizations',
    params: { actors: [actor, actor, secondActor], organizationTypes: ['nonprofit', 'community', 'nonprofit'], visibility: 'unlisted', sortDirection: 'asc', limit: '1' },
    queryResults: [[first, lookahead], [profile]],
    assertions: `
assert(#result.actors == 1 and result.actors[1].did == '${actor}')
assert(result.actors[1].profile.record.displayName == 'Forest Alliance')
assert(result.actors[1].organization.uri == '${first.uri}' and result.actors[1].organization.record.visibility == 'unlisted')
assert(calls[1].values[1] == '${organizationCollection}')
assert(calls[1].sql:find("organization.rkey = 'self'", 1, true))
assert(calls[1].sql:find('organizationType', 1, true) and calls[1].sql:find('visibility', 1, true))
assert(calls[1].sql:find('did IN', 1, true) and calls[1].sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true))
assert(calls[1].values[2] == '${actor}' and calls[1].values[3] == '${secondActor}')
assert(calls[1].values[4] == 'nonprofit' and calls[1].values[5] == 'community' and calls[1].values[6] == 'unlisted')
assert(calls[1].values[#calls[1].values] == 2)
local cursorJson = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(cursorJson)
assert(token.v == 1 and token.d == 'asc' and token.t == '${first.sort_timestamp}' and token.u == '${first.uri}')
assert(calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${actor}')
assert(#calls == 2, 'the lookahead organization must not trigger profile hydration')
`,
  });
});

test('organization visibility omission includes unlisted and unspecified records and malformed dates use a safe sort fallback', () => {
  const unlisted = organizationRow(actor, 'fallback', { visibility: 'unlisted', createdAt: 'not-a-date' }, '2025-01-02T03:04:05.000000Z');
  const unspecified = organizationRow(secondActor, 'unspecified', { organizationType: ['community'], createdAt: '2025-01-01T00:00:00Z' });
  const profile = profileRow(actor, 'fallback-profile', { displayName: 'Unlisted group' });
  runLua({
    endpoint: 'listOrganizations', params: {}, queryResults: [[unlisted, unspecified], [profile]],
    assertions: `
assert(#result.actors == 2 and result.actors[1].organization.record.visibility == 'unlisted')
assert(result.actors[2].organization.record.visibility == nil and result.actors[2].profile == NULL)
assert(not calls[1].sql:find('visibility', 1, true))
assert(calls[1].sql:find('indexed_at', 1, true) and calls[1].sql:find('created_at', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, uri DESC', 1, true))
assert(calls[1].values[2] == 26)
assert(#calls == 2 and calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${actor}' and calls[2].values[3] == '${secondActor}')
`,
  });
});

test('searchOrganizations binds the complete trimmed literal and excludes actors without a profile', () => {
  const organization = organizationRow(actor, 'search', { organizationType: ['nonprofit'], createdAt: '2025-01-01T00:00:00Z' });
  runLua({ endpoint: 'searchOrganizations', params: {}, expectError: 'InvalidRequest:' });
  runLua({
    endpoint: 'searchOrganizations',
    params: { search: '  Forest %_ Restoration  ', organizationTypes: ['nonprofit'] },
    queryResults: [[organization], [profileRow(actor, 'search-profile', { displayName: 'Forest %_ Restoration' })]],
    assertions: `
assert(#result.actors == 1 and result.actors[1].did == '${actor}', 'actor result')
assert(calls[1].sql:find('strpos(lower', 1, true), 'literal substring SQL')
assert(calls[1].sql:find('EXISTS', 1, true) and calls[1].sql:find('profile.did = organization.did', 1, true), 'profile existence predicate')
assert(not calls[1].sql:find('Forest', 1, true), 'search text must be a bound SQL value')
assert(calls[1].values[2] == 'nonprofit' and calls[1].values[3] == 'Forest %_ Restoration', table.concat(calls[1].values, '|'))
assert(calls[1].values[4] == '${profileCollection}', table.concat(calls[1].values, '|'))
assert(calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${actor}', 'profile hydration values')
`,
  });
  runLua({
    endpoint: 'searchOrganizations', params: { search: 'missing profile match' }, queryResults: [[], []],
    assertions: `assert(#result.actors == 0 and #calls == 1, 'no-profile search matches must not hydrate results')`,
  });
});

test('organization listing cursors are direction-bound and use a strict keyset predicate', () => {
  const row = organizationRow(secondActor, 'after', { createdAt: '2025-01-03T00:00:00Z' });
  runLua({
    endpoint: 'listOrganizations',
    params: { sortDirection: 'desc', cursor: cursor({ direction: 'desc' }), limit: '1' },
    queryResults: [[row], []],
    assertions: `
assert(#result.actors == 1 and result.cursor == nil)
assert(calls[1].sql:find('(sorted.sort_at, uri) <', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, uri DESC', 1, true))
assert(calls[1].values[2] == '2025-01-02T03:04:05.000000Z')
assert(calls[1].values[3] == 'at://${actor}/${organizationCollection}/self')
assert(calls[1].values[4] == 2)
`,
  });
  runLua({ endpoint: 'listOrganizations', params: { sortDirection: 'asc', cursor: cursor({ direction: 'desc' }) }, expectError: 'InvalidRequest:', expectedCalls: 0 });
});

test('organization filter occurrence limits apply before duplicate removal', () => {
  const organization = organizationRow(actor, 'bounded-array', { organizationType: ['nonprofit'] });
  runLua({
    endpoint: 'listOrganizations',
    params: { actors: Array(100).fill(actor), organizationTypes: Array(100).fill('nonprofit') },
    queryResults: [[organization], [profileRow(actor, 'bounded-profile', {})]],
    assertions: `
assert(#result.actors == 1 and #calls == 2)
assert(calls[1].sql:find('organization.did IN ($2)', 1, true))
assert(calls[1].values[2] == '${actor}' and calls[1].values[3] == 'nonprofit' and calls[1].values[4] == 26)
`,
  });
});

test('organization queries reject invalid and repeated scalar input before database access', () => {
  runLua({ endpoint: 'getOrganization', params: { actor: 'alice.example' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'getOrganization', params: { actor: [actor, actor] }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { unknown: 'value' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { limit: ['1', '2'] }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { actors: Array(101).fill(actor) }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { organizationTypes: Array(101).fill('nonprofit') }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { sortDirection: 'sideways' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { limit: '0' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { limit: '101' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listOrganizations', params: { foundedAfter: '2020-01-01T00:00:00Z' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'searchOrganizations', params: { search: ['forest', 'group'] }, expectError: 'InvalidRequest:', expectedCalls: 0 });
});

test('organization misses and operational database failures remain distinct errors', () => {
  runLua({ endpoint: 'getOrganization', params: { actor }, queryResults: [[]], expectError: 'RecordNotFound:', expectedCalls: 1 });
  runLua({ endpoint: 'getOrganization', params: { actor }, backend: 'sqlite', expectError: 'OrganizationQueryFailed:', expectedCalls: 0 });
  runLua({ endpoint: 'getOrganization', params: { actor }, queryFailureAt: 1, expectError: 'OrganizationQueryFailed:', expectedCalls: 1 });
  runLua({
    endpoint: 'getOrganization', params: { actor }, queryResults: [[organizationRow(actor, 'hydration-error', {})]], queryFailureAt: 2,
    expectError: 'OrganizationQueryFailed:', expectedCalls: 2,
  });
  runLua({
    endpoint: 'listOrganizations', params: {}, queryResults: [[organizationRow(actor, 'list-error', {})]], queryFailureAt: 2,
    expectError: 'OrganizationQueryFailed:', expectedCalls: 2,
  });
});
