import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const endpointPath = (name) => `lua/endpoints/${name}.lua`;
const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/app.certified.badge.definition/3jzfcijpj2z2z';
const author = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const secondAuthor = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const profileCollection = 'app.certified.actor.profile';
const organizationCollection = 'app.certified.actor.organization';
const indexedAt = '2025-02-01T00:00:01.000Z';

function lua(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function definitionRow(did, rkey, record, sortTimestamp = '2025-02-01T00:00:00.000000Z') {
  return {
    uri: `at://${did}/app.certified.badge.definition/${rkey}`, did, cid: `bafy-${rkey}`,
    indexed_at: indexedAt, record: rkey, record_json: { $type: 'app.certified.badge.definition', ...record },
    sort_timestamp: sortTimestamp,
  };
}

function sidecarRow(collection, did, rkey, record) {
  return {
    uri: `at://${did}/${collection}/${rkey}`, did, cid: `bafy-${collection}-${rkey}`, indexed_at: indexedAt,
    record: `${collection}-${rkey}`, record_json: { $type: collection, ...record },
  };
}

function cursor({ direction = 'asc', timestamp = '2025-02-01T00:00:00.000000Z', recordUri = uri } = {}) {
  return Buffer.from(JSON.stringify({ v: 1, d: direction, t: timestamp, u: recordUri }), 'utf8').toString('hex');
}

function runLua({ endpoint, params, queryResults = [], expectError, expectedCalls = 0, assertions }) {
  const file = endpointPath(endpoint);
  assert.ok(existsSync(`${root}/${file}`), `${file} must be generated before exercising the handler`);
  const records = Object.fromEntries(queryResults.flat().map(({ record, record_json }) => [record, record_json]));
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
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    return RESULTS[#calls] or {}
  end,
}
dofile('${file}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected handler to reject the request')\nassert(tostring(result):find(${JSON.stringify(expectError)}, 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
}

test('getBadgeDefinition reports RecordNotFound when the exact indexed URI is absent', () => {
  runLua({ endpoint: 'getBadgeDefinition', params: { uri }, expectError: 'RecordNotFound:', expectedCalls: 1 });
});

test('getBadgeDefinition preserves icon and allowedIssuers while hydrating nullable author sidecars', () => {
  const record = {
    title: 'Verified watershed', badgeType: 'certification', createdAt: '2025-02-01T00:00:00Z',
    icon: { $type: 'blob', ref: { $link: 'baf-icon' }, mimeType: 'image/png', size: 4 },
    allowedIssuers: [author],
  };
  const definition = definitionRow(author, '3jzfcijpj2z2z', record);
  const profile = sidecarRow(profileCollection, author, 'self', { displayName: 'River Trust' });
  runLua({
    endpoint: 'getBadgeDefinition', params: { uri: definition.uri }, queryResults: [[definition], [profile], []],
    assertions: `
assert(result.badgeDefinition.uri == '${definition.uri}' and result.badgeDefinition.cid == '${definition.cid}')
assert(result.badgeDefinition.record.title == 'Verified watershed')
assert(result.badgeDefinition.record.icon.ref['$link'] == 'baf-icon' and result.badgeDefinition.record.allowedIssuers[1] == '${author}')
assert(result.badgeDefinition.author.did == '${author}' and result.badgeDefinition.author.profile.record.displayName == 'River Trust')
assert(result.badgeDefinition.author.organization == NULL)
assert(calls[1].sql:find('WHERE collection = $1 AND uri = $2', 1, true))
assert(calls[1].values[1] == 'app.certified.badge.definition' and calls[1].values[2] == '${definition.uri}')
assert(calls[2].values[1] == '${profileCollection}' and calls[2].values[2] == '${author}')
assert(calls[3].values[1] == '${organizationCollection}' and calls[3].values[2] == '${author}')
`,
  });
});

test('listBadgeDefinitions combines author and exact badgeType filters, preserves records, and hydrates only the page', () => {
  const icon = { $type: 'blob', ref: { $link: 'baf-icon' }, mimeType: 'image/webp', size: 7 };
  const first = definitionRow(author, 'first', {
    title: 'Forest certification', badgeType: 'certification', createdAt: '2025-02-01T00:00:00Z', icon,
    allowedIssuers: [author, secondAuthor],
  }, '2025-02-01T00:00:00.000000Z');
  const lookahead = definitionRow(secondAuthor, 'lookahead', {
    title: 'Participation', badgeType: 'participation', createdAt: '2025-02-02T00:00:00Z',
  }, '2025-02-02T00:00:00.000000Z');
  const profile = sidecarRow(profileCollection, author, 'self', { displayName: 'Forest Alliance' });
  runLua({
    endpoint: 'listBadgeDefinitions',
    params: { authors: [author, secondAuthor], badgeTypes: ['certification', 'award', 'certification'], sortDirection: 'asc', limit: '1' },
    queryResults: [[first, lookahead], [profile], []],
    assertions: `
assert(#result.badgeDefinitions == 1 and result.badgeDefinitions[1].uri == '${first.uri}')
assert(result.badgeDefinitions[1].record.icon.ref['$link'] == 'baf-icon')
assert(result.badgeDefinitions[1].record.allowedIssuers[2] == '${secondAuthor}')
assert(result.badgeDefinitions[1].author.profile.record.displayName == 'Forest Alliance')
assert(result.badgeDefinitions[1].author.organization == NULL)
assert(calls[1].sql:find('did IN ($2,$3)', 1, true))
assert(calls[1].sql:find("record::jsonb->>'badgeType' IN ($4,$5)", 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, uri ASC', 1, true))
assert(calls[1].values[1] == 'app.certified.badge.definition')
assert(calls[1].values[2] == '${author}' and calls[1].values[3] == '${secondAuthor}')
assert(calls[1].values[4] == 'certification' and calls[1].values[5] == 'award' and calls[1].values[6] == 2)
assert(calls[2].values[1] == '${profileCollection}' and #calls[2].values == 2 and calls[2].values[2] == '${author}')
assert(calls[3].values[1] == '${organizationCollection}' and #calls[3].values == 2 and calls[3].values[2] == '${author}')
local token = json.decode(result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end))
assert(token.v == 1 and token.d == 'asc' and token.t == '${first.sort_timestamp}' and token.u == '${first.uri}')
`,
  });
});

test('listBadgeDefinitions defaults to 25 descending and omits a terminal cursor', () => {
  runLua({
    endpoint: 'listBadgeDefinitions', params: {}, queryResults: [[]],
    assertions: `
assert(#result.badgeDefinitions == 0 and result.cursor == nil)
assert(calls[1].values[1] == 'app.certified.badge.definition' and calls[1].values[2] == 26)
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, uri DESC', 1, true))
`,
  });
});

test('listBadgeDefinitions rejects invalid bounds, array values, unknown keys, and direction-mismatched cursors', () => {
  for (const params of [
    { limit: 0 }, { limit: 101 }, { limit: [1, 2] }, { authors: ['alice.example'] },
    { authors: Array(101).fill(author) }, { badgeTypes: Array(101).fill('award') },
    { badgeTypes: ['x'.repeat(101)] }, { badgeTypes: [7] }, { unknown: 'value' },
    { cursor: cursor({ direction: 'desc' }), sortDirection: 'asc' },
  ]) {
    runLua({ endpoint: 'listBadgeDefinitions', params, expectError: 'InvalidRequest:', expectedCalls: 0 });
  }
});

test('listBadgeDefinitions applies a strict keyset cursor to the createdAt and URI tuple', () => {
  const next = definitionRow(secondAuthor, 'next', {
    title: 'Later page', badgeType: 'award', createdAt: '2025-02-03T00:00:00Z',
  });
  const prior = 'at://did:plc:cccccccccccccccccccccccc/app.certified.badge.definition/prior';
  runLua({
    endpoint: 'listBadgeDefinitions', params: { sortDirection: 'asc', cursor: cursor({ recordUri: prior }) }, queryResults: [[next]],
    assertions: `
assert(#result.badgeDefinitions == 1 and result.badgeDefinitions[1].uri == '${next.uri}')
assert(calls[1].sql:find('(sorted.sort_at, uri) > (($2)::timestamptz, $3)', 1, true))
assert(calls[1].values[1] == 'app.certified.badge.definition')
assert(calls[1].values[2] == '2025-02-01T00:00:00.000000Z' and calls[1].values[3] == '${prior}')
`,
  });
});
