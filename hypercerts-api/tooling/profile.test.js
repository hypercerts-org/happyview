import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAssets } from './installer.js';
import { validatePackageLexicons } from './validate-lexicons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const collection = 'app.certified.actor.profile';
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

function profileRow(did, id, record, createdAt) {
  return {
    uri: `at://${did}/${collection}/self`, did, cid: `bafy-${id}`, indexed_at: indexedAt,
    record: id, record_json: { $type: collection, ...record },
    sort_timestamp: createdAt.replace('Z', '.000000Z'),
  };
}

function cursor({ direction = 'desc', timestamp = '2025-01-02T03:04:05.000000Z', uri = `at://${actor}/${collection}/self` } = {}) {
  return Buffer.from(JSON.stringify({ v: 1, d: direction, t: timestamp, u: uri }), 'utf8').toString('hex');
}

function runLua({ endpoint, params, rows = [], httpResponses = [], resolverUrl, backend = 'postgres', queryFailure = false, expectError, expectedCalls = 0, expectedHttpCalls = 0, errorAssertions = '', captureJson = false, assertions }) {
  const endpointPath = `lua/endpoints/${endpoint}.lua`;
  assert.ok(existsSync(`${root}/${endpointPath}`), `${endpointPath} must be generated before exercising the handler`);
  const storedRecords = Object.fromEntries(rows.map((row) => [row.record, row.record_json]));
  const httpJson = Object.fromEntries(httpResponses.filter((response) => response.value !== undefined).map((response) => [response.body, response.value]));
  const source = `
local RECORDS = ${lua(storedRecords)}
local HTTP_JSON = ${lua(httpJson)}
local rows = ${lua(rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'record_json'))))}
local HTTP_RESPONSES = ${lua(httpResponses.map((response) => ({ status: response.status, body: response.body })))}
local JSON_NULL = {}
env = ${lua(resolverUrl === undefined ? {} : { HYPERCERTS_HANDLE_RESOLVER_URL: resolverUrl })}
local calls, httpCalls = {}, {}
local function decode_cursor(value)
  local version = tonumber(value:match('"v":(%d+)'))
  local direction = value:match('"d":"([^"]*)"')
  local timestamp = value:match('"t":"([^"]*)"')
  local uri = value:match('"u":"([^"]*)"')
  if not version or not direction or not timestamp or not uri then error('invalid cursor JSON') end
  return { v = version, d = direction, t = timestamp, u = uri }
end
json = {
  null = JSON_NULL,
  decode = function(value)
    if value == 'null' then return JSON_NULL end
    if RECORDS[value] then return RECORDS[value] end
    if HTTP_JSON[value] then return HTTP_JSON[value] end
    if value:sub(1, 1) == '{' then return decode_cursor(value) end
    local decoded = value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
    return decode_cursor(decoded)
  end,
  encode = function(value)
    return string.format('{"v":%d,"d":"%s","t":"%s","u":"%s"}', value.v, value.d, value.t, value.u)
  end,
}
toarray = function(value) return value end
local function encode_json(value)
  if value == JSON_NULL then return 'null' end
  local kind = type(value)
  if kind == 'string' then
    assert(not value:find('[%c"]'), 'test JSON encoder expects simple strings')
    return '"' .. value .. '"'
  elseif kind == 'number' or kind == 'boolean' then
    return tostring(value)
  elseif kind == 'table' then
    local is_array, max_index = true, 0
    for key in pairs(value) do
      if type(key) == 'number' then max_index = math.max(max_index, key) else is_array = false end
    end
    local encoded = {}
    if is_array then
      for index = 1, max_index do
        assert(value[index] ~= nil, 'test JSON encoder cannot encode sparse arrays')
        encoded[#encoded + 1] = encode_json(value[index])
      end
      return '[' .. table.concat(encoded, ',') .. ']'
    end
    for key, item in pairs(value) do
      if item ~= nil then encoded[#encoded + 1] = encode_json(key) .. ':' .. encode_json(item) end
    end
    return '{' .. table.concat(encoded, ',') .. '}'
  end
  error('unsupported value in test JSON encoder: ' .. kind)
end
params = ${lua(params)}
http = { get = function(url)
  httpCalls[#httpCalls + 1] = url
  local response = HTTP_RESPONSES[#httpCalls]
  if not response then error('unexpected HTTP request: ' .. url) end
  return response
end }
db = {
  backend = function() return '${backend}' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if ${queryFailure ? 'true' : 'false'} then error('fixture database failure') end
    return rows
  end,
}
dofile('${endpointPath}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected handler to reject the request')\nassert(tostring(result):find('${expectError}', 1, true), tostring(result))\n${errorAssertions}\nassert(#calls == ${expectedCalls}, 'unexpected profile query count')\nassert(#httpCalls == ${expectedHttpCalls}, 'unexpected HTTP request count')`
    : `assert(ok, tostring(result))\n${assertions}\n${captureJson ? 'print(encode_json(result))' : ''}`}
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  return captureJson ? JSON.parse(result.stdout) : result.stdout;
}

test('profile module installs all four endpoint Lexicons and generated handlers', async () => {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  assert.ok(manifest.modules.includes('modules/profile/manifest.json'));
  for (const name of ['getProfile', 'getProfiles', 'listProfiles', 'searchProfiles']) {
    assert.equal(manifest.handlerStatus[name], 'implemented');
  }

  const { assets } = await loadAssets(`${root}/manifest.json`);
  for (const name of ['getProfile', 'getProfiles', 'listProfiles', 'searchProfiles']) {
    const nsid = `app.certified.actor.${name}`;
    assert.ok(assets.some((asset) => asset.id === nsid), `missing installed Lexicon ${nsid}`);
    assert.ok(assets.some((asset) => asset.id === `xrpc.query:${nsid}`), `missing installed handler ${nsid}`);
  }

  const { documents } = await validatePackageLexicons();
  const byId = new Map(documents.map((document) => [document.id, document]));
  const getProfile = byId.get('app.certified.actor.getProfile');
  const getProfiles = byId.get('app.certified.actor.getProfiles');
  const listProfiles = byId.get('app.certified.actor.listProfiles');
  const searchProfiles = byId.get('app.certified.actor.searchProfiles');
  assert.ok(getProfile && getProfiles && listProfiles && searchProfiles, 'all profile query Lexicons must be in the validation closure');
  const profileResult = getProfiles.defs.profileResult;
  assert.deepEqual(getProfile.defs.main.parameters.required, ['actor']);
  assert.equal(getProfile.defs.main.parameters.properties.actor.format, 'at-identifier');
  assert.deepEqual(getProfile.defs.output.required, ['profile']);
  assert.equal(getProfile.defs.output.properties.profile.ref, 'lex:org.hypercerts.api.defs#profileView');
  assert.match(getProfile.defs.main.description, /configured resolver/i);
  assert.match(getProfile.defs.main.description, /no DID document is fetched for independent verification/i);
  assert.doesNotMatch(getProfile.defs.main.description, /claims the handle|alsoKnownAs/i);
  assert.ok(getProfile.defs.main.errors.some(({ name, description }) => name === 'HandleResolverConfigError' && /HYPERCERTS_HANDLE_RESOLVER_URL/.test(description)));
  assert.equal(getProfile.defs.main.errors.some(({ name }) => name === 'HandleVerificationFailed'), false);
  assert.ok(getProfile.defs.main.errors.some(({ name }) => name === 'RecordNotFound'));

  assert.deepEqual(getProfiles.defs.main.parameters.required, ['actors']);
  assert.deepEqual(Object.keys(getProfiles.defs.main.parameters.properties), ['actors']);
  const actorParameters = getProfiles.defs.main.parameters.properties.actors;
  assert.equal(actorParameters.type, 'array');
  assert.equal(actorParameters.minLength, 1);
  assert.equal(actorParameters.maxLength, 100);
  assert.equal(actorParameters.items.type, 'string');
  assert.equal(actorParameters.items.format, 'did');
  assert.deepEqual(getProfiles.defs.output.required, ['profiles']);
  assert.equal(getProfiles.defs.output.properties.profiles.items.ref, 'lex:app.certified.actor.getProfiles#profileResult');
  assert.equal(profileResult.type, 'object');
  assert.deepEqual(profileResult.required, ['actor', 'profile']);
  assert.deepEqual(profileResult.nullable, ['profile']);
  assert.equal(profileResult.properties.actor.format, 'did');
  assert.equal(profileResult.properties.profile.ref, 'lex:org.hypercerts.api.defs#profileView');

  const listParameters = listProfiles.defs.main.parameters.properties;
  const searchParameters = searchProfiles.defs.main.parameters.properties;
  assert.deepEqual(Object.keys(listParameters).sort(), ['actors', 'cursor', 'limit', 'sortDirection']);
  assert.equal(listParameters.search, undefined, 'listing must not expose text search');
  assert.deepEqual(searchProfiles.defs.main.parameters.required, ['search']);
  assert.deepEqual(Object.keys(searchParameters).sort(), ['actors', 'cursor', 'limit', 'search', 'sortDirection']);
  assert.equal(searchParameters.actors.items.format, 'did');
  assert.equal(searchParameters.actors.maxLength, 100);
  for (const query of [listProfiles, searchProfiles]) {
    assert.equal(query.defs.main.parameters.properties.limit.minimum, 1);
    assert.equal(query.defs.main.parameters.properties.limit.maximum, 100);
    assert.equal(query.defs.output.properties.profiles.items.ref, 'lex:org.hypercerts.api.defs#profileView');
  }
});

test('getProfiles preserves every requested DID occurrence and returns explicit null for missing profiles', () => {
  const requested = [secondActor, 'did:plc:cccccccccccccccccccccccc', actor, secondActor];
  const first = profileRow(actor, 'first', {
    displayName: 'Forest Commons', createdAt: '2025-01-01T00:00:00Z',
  }, '2025-01-01T00:00:00Z');
  const second = profileRow(secondActor, 'second', {
    displayName: 'River Commons', createdAt: '2025-01-02T00:00:00Z',
  }, '2025-01-02T00:00:00Z');
  const result = runLua({
    endpoint: 'getProfiles', params: { actors: requested }, rows: [first, second], captureJson: true,
    assertions: 'assert(#calls == 1 and #httpCalls == 0)',
  });

  assert.deepEqual(result.profiles.map(({ actor: did }) => did), requested);
  assert.deepEqual(result.profiles.map(({ profile }) => profile?.did ?? null), [secondActor, null, actor, secondActor]);
  assert.equal(Object.hasOwn(result.profiles[1], 'profile'), true);
  assert.equal(result.profiles[1].profile, null);
  assert.equal(Object.hasOwn(result, 'cursor'), false);

  const single = runLua({
    endpoint: 'getProfiles', params: { actors: actor }, rows: [first], captureJson: true,
    assertions: 'assert(#calls == 1 and #httpCalls == 0)',
  });
  assert.equal(single.profiles.length, 1);
  assert.equal(single.profiles[0].actor, actor);
  assert.equal(single.profiles[0].profile.did, actor);
});

test('getProfiles requires 1..100 valid DIDs before querying', () => {
  for (const params of [
    {},
    { actors: [] },
    { actors: Array(101).fill(actor) },
    { actors: ['alice.example'] },
    { actors: [actor], cursor: 'not-accepted' },
  ]) {
    runLua({ endpoint: 'getProfiles', params, expectError: 'InvalidRequest:', expectedCalls: 0, expectedHttpCalls: 0 });
  }
});

test('getProfile returns the complete indexed profile view without sidecar queries', () => {
  const record = { displayName: 'Forest Commons', description: 'A profile with its original fields', createdAt: '2025-01-01T00:00:00Z' };
  const row = profileRow(actor, 'one', record, record.createdAt);
  runLua({
    endpoint: 'getProfile', params: { actor }, rows: [row],
    assertions: `
assert(result.profile.uri == '${row.uri}' and result.profile.cid == '${row.cid}')
assert(result.profile.indexedAt == '${indexedAt}' and result.profile.did == '${actor}')
assert(result.profile.record['$type'] == '${collection}')
assert(result.profile.record.displayName == 'Forest Commons')
assert(result.profile.record.description == 'A profile with its original fields')
assert(result.profile.organization == nil and #calls == 1 and #httpCalls == 0)
assert(calls[1].values[1] == '${collection}' and calls[1].values[2] == '${actor}')
assert(calls[1].sql:find("rkey = 'self'", 1, true))
`,
  });
});

test('getProfile resolves a handle once through the configured resolver and does not fetch a DID document', () => {
  const record = { displayName: 'Alice', createdAt: '2025-01-01T00:00:00Z' };
  const row = profileRow(actor, 'alice', record, record.createdAt);
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, rows: [row],
    resolverUrl: 'https://resolver.example',
    httpResponses: [{ status: 200, body: 'resolved-handle', value: { did: actor } }],
    assertions: `
assert(result.profile.did == '${actor}' and result.profile.record.displayName == 'Alice')
assert(#httpCalls == 1 and #calls == 1)
assert(httpCalls[1] == 'https://resolver.example/xrpc/com.atproto.identity.resolveHandle?handle=alice.example')
assert(calls[1].values[2] == '${actor}')
`,
  });
});

test('getProfile accepts a valid IPv4 resolver base URL', () => {
  const record = { displayName: 'Alice', createdAt: '2025-01-01T00:00:00Z' };
  const row = profileRow(actor, 'alice', record, record.createdAt);
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, rows: [row],
    resolverUrl: 'https://192.0.2.10:8443',
    httpResponses: [{ status: 200, body: 'ipv4-resolver', value: { did: actor } }],
    assertions: `
assert(#httpCalls == 1 and httpCalls[1] == 'https://192.0.2.10:8443/xrpc/com.atproto.identity.resolveHandle?handle=alice.example')
assert(result.profile.did == '${actor}')
`,
  });
});

test('getProfile accepts a valid bracketed IPv6 resolver base URL', () => {
  const record = { displayName: 'Alice', createdAt: '2025-01-01T00:00:00Z' };
  const row = profileRow(actor, 'alice', record, record.createdAt);
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, rows: [row],
    resolverUrl: 'https://[2001:db8::1]',
    httpResponses: [{ status: 200, body: 'ipv6-resolver', value: { did: actor } }],
    assertions: `
assert(#httpCalls == 1 and httpCalls[1] == 'https://[2001:db8::1]/xrpc/com.atproto.identity.resolveHandle?handle=alice.example')
assert(result.profile.did == '${actor}')
`,
  });
});

test('handle lookup rejects missing or unsafe resolver configuration before HTTP', () => {
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' },
    expectError: 'HYPERCERTS_HANDLE_RESOLVER_URL', expectedHttpCalls: 0,
    errorAssertions: "assert(tostring(result):find('HandleResolverConfigError:', 1, true), tostring(result))",
  });
  for (const resolverUrl of [
    'http://resolver.example',
    'https://user:secret@resolver.example',
    'https://resolver.example?tenant=one',
    'https://resolver.example/path',
    'https://resolver.example#fragment',
    'https://999.999.999.999',
    'https://999.1',
    'https://[:::]',
    'https://resolver.example\\\\@evil.example',
  ]) {
    runLua({
      endpoint: 'getProfile', params: { actor: 'alice.example' }, resolverUrl,
      expectError: 'HandleResolverConfigError:', expectedHttpCalls: 0,
      errorAssertions: "assert(tostring(result):find('HYPERCERTS_HANDLE_RESOLVER_URL', 1, true), tostring(result))",
    });
  }
});

test('resolver transport and invalid DID responses stay distinct from indexed RecordNotFound', () => {
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, resolverUrl: 'https://resolver.example',
    httpResponses: [{ status: 503, body: 'unavailable' }],
    expectError: 'HandleResolutionFailed:', expectedHttpCalls: 1,
  });
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, resolverUrl: 'https://resolver.example',
    httpResponses: [{ status: 200, body: 'invalid-did', value: { did: 'not-a-did' } }],
    expectError: 'HandleResolutionFailed:', expectedHttpCalls: 1,
  });
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, resolverUrl: 'https://resolver.example',
    httpResponses: [{ status: 200, body: 'malformed-escape-did', value: { did: 'did:plc:abc%GG' } }],
    expectError: 'HandleResolutionFailed:', expectedCalls: 0, expectedHttpCalls: 1,
  });
  runLua({
    endpoint: 'getProfile', params: { actor: 'alice.example' }, resolverUrl: 'https://resolver.example',
    httpResponses: [{ status: 200, body: 'resolved-handle', value: { did: actor } }],
    expectError: 'RecordNotFound:', expectedCalls: 1, expectedHttpCalls: 1,
  });
  runLua({ endpoint: 'getProfile', params: { actor }, expectError: 'RecordNotFound:', expectedCalls: 1, expectedHttpCalls: 0 });
});

test('listProfiles deduplicates DIDs and paginates the shared profile view by createdAt and URI', () => {
  const first = profileRow(actor, 'first', {
    displayName: '100%_Forest', description: 'Upper river', createdAt: '2025-01-01T00:00:00Z',
  }, '2025-01-01T00:00:00Z');
  const lookahead = profileRow(secondActor, 'next', {
    displayName: 'Another forest', createdAt: '2025-01-02T00:00:00Z',
  }, '2025-01-02T00:00:00Z');
  runLua({
    endpoint: 'listProfiles',
    params: { actors: [actor, actor, secondActor], sortDirection: 'asc', limit: '1' },
    rows: [first, lookahead],
    assertions: `
assert(#result.profiles == 1 and result.profiles[1].uri == '${first.uri}')
assert(result.profiles[1].record.displayName == '100%_Forest')
assert(result.profiles[1].did == '${actor}' and result.profiles[1].cid == '${first.cid}')
assert(result.profiles[1].indexedAt == '${indexedAt}' and result.profiles[1].organization == nil)
assert(calls[1].values[1] == '${collection}')
assert(calls[1].values[2] == '${actor}' and calls[1].values[3] == '${secondActor}')
assert(calls[1].values[4] == 2)
local sql = calls[1].sql
assert(sql:find('did IN ($2, $3)', 1, true))
assert(not sql:find('strpos', 1, true))
assert(sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true))
assert(result.cursor ~= nil)
local tokenJson = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(tokenJson)
assert(token.v == 1 and token.d == 'asc' and token.t == '${first.sort_timestamp}' and token.u == '${first.uri}')
assert(#calls == 1, 'profile results must not trigger sidecar hydration')
`,
  });
});

test('searchProfiles requires search and combines trimmed literal search with deduplicated actors', () => {
  const first = profileRow(actor, 'first', {
    displayName: '100%_Forest', description: 'Upper river', createdAt: '2025-01-01T00:00:00Z',
  }, '2025-01-01T00:00:00Z');
  const lookahead = profileRow(secondActor, 'next', {
    displayName: 'Another forest', createdAt: '2025-01-02T00:00:00Z',
  }, '2025-01-02T00:00:00Z');
  runLua({ endpoint: 'searchProfiles', params: {}, expectError: 'InvalidRequest:' });
  runLua({
    endpoint: 'searchProfiles',
    params: { actors: [actor, actor, secondActor], search: '  100%_FOREST  ', sortDirection: 'asc', limit: '1' },
    rows: [first, lookahead],
    assertions: `
assert(#result.profiles == 1 and result.profiles[1].uri == '${first.uri}')
assert(result.profiles[1].record.displayName == '100%_Forest')
assert(result.profiles[1].did == '${actor}' and result.profiles[1].cid == '${first.cid}')
assert(result.profiles[1].indexedAt == '${indexedAt}' and result.profiles[1].organization == nil)
assert(calls[1].values[1] == '${collection}')
assert(calls[1].values[2] == '${actor}' and calls[1].values[3] == '${secondActor}')
assert(calls[1].values[4] == '100%_forest' and calls[1].values[5] == 2)
local sql = calls[1].sql
assert(sql:find('did IN ($2, $3)', 1, true))
assert(sql:find('AND', 1, true) and sql:find('strpos', 1, true))
assert(not sql:find('100%%_forest', 1, true), 'search text must stay a bound literal, not SQL pattern syntax')
assert(sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true))
assert(result.cursor ~= nil)
local tokenJson = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(tokenJson)
assert(token.v == 1 and token.d == 'asc' and token.t == '${first.sort_timestamp}' and token.u == '${first.uri}')
assert(#calls == 1, 'profile results must not trigger sidecar hydration')
`,
  });
});

test('listProfiles and searchProfiles apply the same direction-bound keyset cursor', () => {
  const row = profileRow(secondActor, 'after-cursor', {
    displayName: 'Forest group', createdAt: '2025-01-03T00:00:00Z',
  }, '2025-01-03T00:00:00Z');
  const before = `at://${actor}/${collection}/self`;
  for (const endpoint of ['listProfiles', 'searchProfiles']) {
    const searchEnabled = endpoint === 'searchProfiles';
    const params = {
      sortDirection: 'asc', limit: '1',
      cursor: cursor({ direction: 'asc', timestamp: '2025-01-02T00:00:00.000000Z', uri: before }),
      ...(searchEnabled ? { search: 'forest' } : {}),
    };
    const cursorIndex = searchEnabled ? 3 : 2;
    runLua({
      endpoint, params, rows: [row],
      assertions: `
assert(#result.profiles == 1 and result.profiles[1].uri == '${row.uri}')
assert(result.profiles[1].record.displayName == 'Forest group')
assert(result.cursor == nil)
assert(calls[1].sql:find('(sorted.sort_at, uri) >', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true))
assert(calls[1].values[${cursorIndex}] == '2025-01-02T00:00:00.000000Z')
assert(calls[1].values[${cursorIndex + 1}] == '${before}')
assert(calls[1].values[${cursorIndex + 2}] == 2)
`,
    });
  }
});

test('listProfiles and blank searchProfiles share defaults, views, and terminal pagination behavior', () => {
  for (const [endpoint, params] of [['listProfiles', {}], ['searchProfiles', { search: '   ' }]]) {
    runLua({
      endpoint, params, rows: [],
      assertions: `
assert(#result.profiles == 0 and result.cursor == nil)
assert(calls[1].values[1] == '${collection}' and calls[1].values[2] == 26)
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, uri DESC', 1, true))
assert(not calls[1].sql:find('strpos', 1, true))
`,
    });
  }
});

test('listProfiles rejects search and both listing endpoints reject invalid filters before querying', () => {
  runLua({ endpoint: 'listProfiles', params: { search: 'forest' }, expectError: 'InvalidRequest:' });
  for (const endpoint of ['listProfiles', 'searchProfiles']) {
    runLua({ endpoint, params: { actors: ['alice.example'], ...(endpoint === 'searchProfiles' ? { search: 'forest' } : {}) }, expectError: 'InvalidRequest:' });
    runLua({ endpoint, params: { actors: Array(101).fill(actor), ...(endpoint === 'searchProfiles' ? { search: 'forest' } : {}) }, expectError: 'InvalidRequest:' });
    runLua({ endpoint, params: { cursor: 'not-hex', ...(endpoint === 'searchProfiles' ? { search: 'forest' } : {}) }, expectError: 'InvalidRequest:' });
    runLua({ endpoint, params: { sortDirection: 'asc', cursor: cursor({ direction: 'desc' }), ...(endpoint === 'searchProfiles' ? { search: 'forest' } : {}) }, expectError: 'InvalidRequest:' });
  }
});
