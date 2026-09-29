import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ACTIVITY = 'org.hypercerts.claim.activity';
const CONTRIBUTOR_INFORMATION = 'org.hypercerts.claim.contributorInformation';
const PROFILE = 'app.certified.actor.profile';
const ORGANIZATION = 'app.certified.actor.organization';
const authorDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const contributorDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const activityUri = `at://${authorDid}/${ACTIVITY}/activity-one`;
const contributorInformationUri = `at://${authorDid}/${CONTRIBUTOR_INFORMATION}/3jzfcijpj2z2a`;
const oldCid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const latestCid = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const indexedAt = '2025-01-02T03:04:05.000Z';
const activityRecord = {
  $type: ACTIVITY,
  title: 'Version-pinned activity',
  shortDescription: 'Contributor information must match the referenced CID.',
  createdAt: indexedAt,
  contributors: [
    { contributorIdentity: { uri: contributorInformationUri, cid: oldCid }, contributionWeight: 'first' },
    { contributorIdentity: { uri: contributorInformationUri, cid: oldCid }, contributionWeight: 'second' },
    { contributorIdentity: { identity: contributorDid }, contributionWeight: 'third' },
  ],
};
const rows = [
  {
    uri: activityUri, did: authorDid, collection: ACTIVITY, cid: 'bafyreicccccccccccccccccccccccccccccccccccccccccccccccccccc',
    indexed_at: indexedAt, record: 'activity', record_json: activityRecord,
  },
  {
    uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE, cid: 'bafyreidddddddddddddddddddddddddddddddddddddddddddddddddddd',
    indexed_at: indexedAt, record: 'author-profile', record_json: { $type: PROFILE, displayName: 'Activity author', createdAt: indexedAt },
  },
  {
    uri: contributorInformationUri, did: authorDid, collection: CONTRIBUTOR_INFORMATION, cid: latestCid,
    indexed_at: indexedAt, record: 'latest-contributor-information', record_json: {
      $type: CONTRIBUTOR_INFORMATION, identifier: contributorDid, displayName: 'Newer version only', createdAt: indexedAt,
    },
  },
  {
    uri: `at://${contributorDid}/${PROFILE}/self`, did: contributorDid, collection: PROFILE, cid: 'bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    indexed_at: indexedAt, record: 'contributor-profile', record_json: { $type: PROFILE, displayName: 'Inline contributor', createdAt: indexedAt },
  },
];

function lua(value) {
  if (value === null) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function withoutRecordJson(row) {
  const databaseRow = { ...row };
  delete databaseRow.record_json;
  return databaseRow;
}

test('activity API manifests and Lexicons declare the implemented endpoint contracts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const module = JSON.parse(await readFile(new URL('../modules/activity/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual({
    getActivity: manifest.handlerStatus.getActivity,
    listActivities: manifest.handlerStatus.listActivities,
    searchActivities: manifest.handlerStatus.searchActivities,
  }, { getActivity: 'implemented', listActivities: 'implemented', searchActivities: 'implemented' });
  assert.ok(manifest.modules.includes('modules/activity/manifest.json'));
  for (const nsid of ['org.hypercerts.claim.activity', 'org.hypercerts.claim.contributorInformation']) {
    assert.ok(manifest.validationLexicons.some(({ id, packagePath }) => id === nsid && packagePath));
  }

  const endpointNames = ['getActivity', 'listActivities', 'searchActivities'];
  for (const name of endpointNames) {
    const nsid = `org.hypercerts.claim.${name}`;
    const lexiconPath = `../lexicons/${nsid}.json`;
    const schema = JSON.parse(await readFile(new URL(lexiconPath, import.meta.url), 'utf8'));
    assert.equal(schema.id, nsid);
    assert.ok(manifest.validationLexicons.some(({ id, path }) => id === nsid && path));
    const script = module.assets.find(({ kind, id }) => kind === 'script' && id === `xrpc.query:${nsid}`);
    assert.ok(script, `missing handler declaration for ${nsid}`);
    assert.equal(script.sourcePath, `../../lua/src/${name}.lua`);
    assert.ok(manifest.luaBuild.endpointSources.includes(`lua/src/${name}.lua`));
  }

  const getSchema = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.claim.getActivity.json', import.meta.url), 'utf8'));
  assert.deepEqual(getSchema.defs.main.parameters.required, ['uri']);
  assert.deepEqual(getSchema.defs.activityView.required, ['uri', 'cid', 'indexedAt', 'did', 'author', 'record']);
  assert.deepEqual(getSchema.defs.activityView.nullable, ['indexedAt']);
  assert.deepEqual(getSchema.defs.contributorInformationView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.deepEqual(getSchema.defs.contributorInformationView.nullable, ['indexedAt']);
  assert.deepEqual(getSchema.defs.activityContributorView.required, ['contributorIdentity', 'contributorInformation', 'actor']);
  assert.deepEqual(getSchema.defs.activityContributorView.nullable, ['contributorInformation', 'actor']);
  assert.deepEqual(getSchema.defs.contributorActorView.required, ['did', 'profile']);
  assert.deepEqual(getSchema.defs.contributorActorView.nullable, ['profile']);

  const listSchema = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.claim.listActivities.json', import.meta.url), 'utf8'));
  const searchSchema = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.claim.searchActivities.json', import.meta.url), 'utf8'));
  assert.equal(listSchema.defs.main.parameters.properties.uris.maxLength, 100);
  assert.equal(listSchema.defs.main.parameters.properties.limit.maximum, 100);
  assert.deepEqual(searchSchema.defs.main.parameters.required, ['search']);
  assert.equal(searchSchema.defs.main.parameters.properties.contributors.maxLength, 100);
  assert.equal(listSchema.defs.output.properties.activities.items.ref, `${getSchema.id}#activityView`);
  assert.equal(searchSchema.defs.output.properties.activities.items.ref, `${getSchema.id}#activityView`);
});

function runGetActivity({
  uri = activityUri,
  recordJson = activityRecord,
  assertions = '',
  activityIndexedAt = indexedAt,
  extraRows = [],
  serialize = false,
} = {}) {
  const activityDatabaseRow = { ...rows[0], uri, indexed_at: activityIndexedAt, record_json: recordJson };
  const scenarioRows = [activityDatabaseRow, ...rows.slice(1), ...extraRows];
  const records = Object.fromEntries(scenarioRows.map(({ record, record_json }) => [record, record_json]));
  const databaseRows = scenarioRows.map(withoutRecordJson);
  const source = `
local NULL = {}
local RECORDS = ${lua(records)}
local ROWS = ${lua(databaseRows)}
local calls = {}
local function encode_json_string(value)
  local output, backslash = {'"'}, string.char(92)
  for index = 1, #value do
    local byte = value:byte(index)
    local character = value:sub(index, index)
    if byte == 34 then output[#output + 1] = backslash .. '"'
    elseif byte == 92 then output[#output + 1] = backslash .. backslash
    elseif byte == 8 then output[#output + 1] = backslash .. 'b'
    elseif byte == 9 then output[#output + 1] = backslash .. 't'
    elseif byte == 10 then output[#output + 1] = backslash .. 'n'
    elseif byte == 12 then output[#output + 1] = backslash .. 'f'
    elseif byte == 13 then output[#output + 1] = backslash .. 'r'
    elseif byte < 32 then output[#output + 1] = backslash .. 'u' .. string.format('%04x', byte)
    else output[#output + 1] = character end
  end
  output[#output + 1] = '"'
  return table.concat(output)
end
local function encode_json(value)
  if value == NULL then return 'null' end
  local kind = type(value)
  if kind == 'string' then return encode_json_string(value) end
  if kind == 'number' then
    assert(value == value and value ~= math.huge and value ~= -math.huge, 'invalid JSON number')
    return tostring(value)
  end
  if kind == 'boolean' then return tostring(value) end
  assert(kind == 'table', 'unsupported JSON value: ' .. kind)
  local count, max_index, is_array = 0, 0, true
  for key in pairs(value) do
    if type(key) == 'number' and key >= 1 and key % 1 == 0 then
      count = count + 1
      if key > max_index then max_index = key end
    else
      is_array = false
    end
  end
  if is_array and count == max_index then
    local items = {}
    for index = 1, max_index do items[index] = encode_json(value[index]) end
    return '[' .. table.concat(items, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do
    assert(type(key) == 'string', 'JSON object keys must be strings')
    keys[#keys + 1] = key
  end
  table.sort(keys)
  local fields = {}
  for _, key in ipairs(keys) do
    fields[#fields + 1] = encode_json_string(key) .. ':' .. encode_json(value[key])
  end
  return '{' .. table.concat(fields, ',') .. '}'
end
json = {
  decode = function(value) if value == 'null' then return NULL end return RECORDS[value] end,
  encode = encode_json,
}
toarray = function(value) return value end
params = { uri = '${uri}' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    local results = {}
    for _, row in ipairs(ROWS) do
      if row.collection == values[1] then
        local matches = true
        if sql:find('uri = $2', 1, true) and row.uri ~= values[2] then matches = false end
        if sql:find('cid = $3', 1, true) and row.cid ~= values[3] then matches = false end
        if sql:find('did = $2', 1, true) and row.did ~= values[2] then matches = false end
        if sql:find('did IN (', 1, true) then
          local found = false
          for index = 2, #values do if row.did == values[index] then found = true end end
          if not found then matches = false end
        end
        if matches then results[#results + 1] = row end
      end
    end
    return results
  end,
}
dofile('lua/endpoints/getActivity.lua')
local result = handle()
local activity = result.activity
assert(activity.uri == '${uri}')
${assertions}
${serialize ? 'print(json.encode(result))' : ''}
`;
  return spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
}

test('getActivity serializes a null activity indexed_at as explicit JSON null', () => {
  const result = runGetActivity({ activityIndexedAt: null, serialize: true });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);

  const body = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(body.activity, 'indexedAt'), true);
  assert.equal(body.activity.indexedAt, null);
});

test('getActivity serializes exact-version contributor indexed_at null and timestamp strings', () => {
  const exactInformation = {
    ...rows[2], cid: oldCid, record: 'exact-contributor-information',
    record_json: {
      $type: CONTRIBUTOR_INFORMATION, identifier: contributorDid, displayName: 'Exact version', createdAt: indexedAt,
    },
  };
  const serializeActivity = (informationIndexedAt) => {
    const result = runGetActivity({
      extraRows: [{ ...exactInformation, indexed_at: informationIndexedAt }],
      serialize: true,
    });
    assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
    return JSON.parse(result.stdout).activity;
  };

  const nullable = serializeActivity(null);
  assert.equal(nullable.indexedAt, indexedAt);
  assert.equal(nullable.contributors[0].contributorInformation.cid, oldCid);
  assert.equal(Object.hasOwn(nullable.contributors[0].contributorInformation, 'indexedAt'), true);
  assert.equal(nullable.contributors[0].contributorInformation.indexedAt, null);

  const timestamped = serializeActivity(indexedAt);
  assert.equal(timestamped.indexedAt, indexedAt);
  assert.equal(timestamped.contributors[0].contributorInformation.indexedAt, indexedAt);
});

test('getActivity includes an indexed organization sidecar in the fully hydrated author', () => {
  const uri = `at://${authorDid}/${ACTIVITY}/organization-author`;
  const activity = activityRow({
    uri, cid: 'bafyreillllllllllllllllllllllllllllllllllllllllllllllllllll',
    record: { title: 'Organization author', shortDescription: 'Author hydration', createdAt: indexedAt },
  });
  const profile = {
    uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE, cid: 'bafyreimmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',
    indexed_at: indexedAt, record: 'organization-author-profile', record_json: { $type: PROFILE, displayName: 'Organization author profile', createdAt: indexedAt },
  };
  const organization = {
    uri: `at://${authorDid}/${ORGANIZATION}/self`, did: authorDid, collection: ORGANIZATION, cid: 'bafyreinnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    indexed_at: indexedAt, record: 'organization-author-sidecar', record_json: { $type: ORGANIZATION, organizationType: ['nonprofit'], createdAt: indexedAt },
  };
  const result = runLuaEndpoint({
    endpoint: 'getActivity', params: { uri }, queryResults: [[activity], [profile], [organization]],
    assertions: `
assert(result.activity.author.profile.record.displayName == 'Organization author profile')
assert(result.activity.author.organization.uri == '${organization.uri}')
assert(result.activity.author.organization.cid == '${organization.cid}')
assert(result.activity.author.organization.record.organizationType[1] == 'nonprofit')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('getActivity does not substitute a newer contributor-information record at the same URI', () => {
  const result = runGetActivity({ assertions: `
assert(activity.record.title == 'Version-pinned activity')
assert(#activity.record.contributors == 3)
assert(activity.record.contributors[1].contributorIdentity.uri == '${contributorInformationUri}')
assert(activity.record.contributors[1].contributorIdentity.cid == '${oldCid}')
assert(activity.record.contributors[1].contributorInformation == nil and activity.record.contributors[1].actor == nil,
  'source record must remain unchanged')
assert(activity.contributors[1].contributorInformation == NULL, 'newer contributor-information CID must not hydrate')
assert(activity.contributors[1].actor == NULL, 'identity from a different CID must not hydrate')
assert(activity.contributors[1].contributionWeight == 'first' and activity.contributors[2].contributionWeight == 'second')
assert(activity.contributors[2].contributorInformation == NULL and activity.contributors[2].actor == NULL)
assert(activity.contributors[1].contributorIdentity.uri == '${contributorInformationUri}' and activity.contributors[2].contributorIdentity.cid == '${oldCid}')
assert(activity.contributors[3].actor.did == '${contributorDid}')
assert(activity.contributors[3].actor.profile.record.displayName == 'Inline contributor')
assert(activity.author.did == '${authorDid}')
assert(activity.author.profile.record.displayName == 'Activity author')
assert(activity.author.organization == NULL)
local checkedExactCid = false
for _, call in ipairs(calls) do
  if call.values[1] == '${CONTRIBUTOR_INFORMATION}' then
    assert(call.values[2] == '${contributorInformationUri}')
    assert(call.values[3] == '${oldCid}')
    assert(call.sql:find('cid = $3', 1, true), 'contributor-information lookup must constrain both URI and CID')
    checkedExactCid = true
  end
end
assert(checkedExactCid, 'expected an exact contributor-information version lookup')
` });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

function runLuaEndpoint({ endpoint, params, queryResults, assertions = '', expectError, expectedCalls = 0, backend = 'postgres', queryFailureAt = 0 }) {
  const recordMap = Object.fromEntries(queryResults.flat().map(({ record, record_json }) => [record, record_json]));
  const rowsByCall = queryResults.map((result) => result.map(withoutRecordJson));
  const source = `
local RECORDS = ${lua(recordMap)}
local RESULTS = ${lua(rowsByCall)}
local NULL = {}
local calls = {}
local function decode_cursor(value)
  return {
    v = tonumber(value:match('"v":(%d+)')),
    d = value:match('"d":"([^"]*)"'),
    t = value:match('"t":"([^"]*)"'),
    u = value:match('"u":"([^"]*)"'),
  }
end
json = {
  decode = function(value)
    if value == 'null' then return NULL end
    if RECORDS[value] then return RECORDS[value] end
    if value:sub(1, 1) == '{' then return decode_cursor(value) end
    return decode_cursor(value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end))
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
    if ${queryFailureAt} == #calls then error('fixture database failure') end
    return RESULTS[#calls] or {}
  end,
}
dofile('lua/endpoints/${endpoint}.lua')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected request to fail')\nassert(tostring(result):find('${expectError}', 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  return spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
}

function activityRow({ uri, did = authorDid, record, cid, sortTimestamp }) {
  return {
    uri, did, collection: ACTIVITY, cid, indexed_at: indexedAt,
    record: uri, record_json: { $type: ACTIVITY, ...record },
    ...(sortTimestamp ? { sort_timestamp: sortTimestamp } : {}),
  };
}

test('listActivities combines actor, author-type, URI, and contributor filters before paging and hydrates only the page', () => {
  const firstUri = `at://${authorDid}/${ACTIVITY}/first`;
  const lookaheadUri = `at://${authorDid}/${ACTIVITY}/lookahead`;
  const exactInfoCid = 'bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const lookaheadInfoUri = `at://${authorDid}/${CONTRIBUTOR_INFORMATION}/lookahead`;
  const exactInfoUri = `at://${authorDid}/${CONTRIBUTOR_INFORMATION}/exact`;
  const first = activityRow({
    uri: firstUri, cid: 'bafyreiggggggggggggggggggggggggggggggggggggggggggggggggggg',
    sortTimestamp: '2025-01-01T00:00:00.000000Z',
    record: {
      title: 'First activity', shortDescription: 'Matching contributor', createdAt: '2025-01-01T00:00:00Z',
      contributors: [{ contributorIdentity: { uri: exactInfoUri, cid: exactInfoCid } }],
    },
  });
  const lookahead = activityRow({
    uri: lookaheadUri, cid: 'bafyreihhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh',
    sortTimestamp: '2025-01-02T00:00:00.000000Z',
    record: {
      title: 'Lookahead activity', shortDescription: 'Must not be hydrated', createdAt: '2025-01-02T00:00:00Z',
      contributors: [{ contributorIdentity: { uri: lookaheadInfoUri, cid: 'bafyreijjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj' } }],
    },
  });
  const info = {
    uri: exactInfoUri, did: authorDid, collection: CONTRIBUTOR_INFORMATION, cid: exactInfoCid,
    indexed_at: indexedAt, record: 'exact-info', record_json: {
      $type: CONTRIBUTOR_INFORMATION, identifier: contributorDid, displayName: 'Exact contributor', createdAt: indexedAt,
    },
  };
  const authorProfile = {
    uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE, cid: 'bafyreikkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
    indexed_at: indexedAt, record: 'list-author-profile', record_json: { $type: PROFILE, displayName: 'List author', createdAt: indexedAt },
  };
  const contributorProfile = {
    uri: `at://${contributorDid}/${PROFILE}/self`, did: contributorDid, collection: PROFILE, cid: 'bafyreillllllllllllllllllllllllllllllllllllllllllllllllllll',
    indexed_at: indexedAt, record: 'list-contributor-profile', record_json: { $type: PROFILE, displayName: 'List contributor', createdAt: indexedAt },
  };
  const result = runLuaEndpoint({
    endpoint: 'listActivities',
    params: {
      authors: [authorDid, authorDid], authorType: 'person', contributors: [contributorDid, contributorDid],
      involvedActors: [contributorDid, contributorDid], uris: [firstUri, lookaheadUri, firstUri], sortDirection: 'asc', limit: '1',
    },
    queryResults: [[first, lookahead], [info], [authorProfile, contributorProfile], []],
    assertions: `
assert(#result.activities == 1 and result.activities[1].uri == '${firstUri}')
assert(result.cursor ~= nil, 'lookahead row must produce a next-page cursor')
local cursorJson = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(cursorJson)
assert(token.v == 1 and token.d == 'asc' and token.t == '2025-01-01T00:00:00.000000Z' and token.u == '${firstUri}')
assert(result.activities[1].author.profile.record.displayName == 'List author')
assert(result.activities[1].contributors[1].contributorInformation.record.displayName == 'Exact contributor')
assert(result.activities[1].contributors[1].actor.profile.record.displayName == 'List contributor')
local sql = calls[1].sql
assert(sql:find('activity.did IN ($2)', 1, true), 'duplicate author DIDs must be removed before binding')
assert(sql:find('activity.uri IN ($6, $7)', 1, true), 'duplicate URIs must be removed before binding')
assert(sql:find('organization', 1, true) and sql:find('profile', 1, true), 'authorType must distinguish organization and person authors')
assert(sql:find('jsonb_array_elements', 1, true), 'contributor matching must inspect each contributor entry')
assert(sql:find('ci.cid', 1, true) and sql:find('ci.uri', 1, true), 'contributor references must join by exact CID and URI')
assert(sql:find('ORDER BY sorted.sort_at ASC, activity.uri ASC', 1, true))
assert(sql:find(' OR EXISTS (SELECT', 1, true), 'involvedActors must match authors or contributors')
local hydrationValues = table.concat(calls[2].values, '|')
assert(hydrationValues:find('${exactInfoUri}', 1, true) and hydrationValues:find('${exactInfoCid}', 1, true))
assert(not hydrationValues:find('${lookaheadInfoUri}', 1, true), 'lookahead contributor information must not be hydrated')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('searchActivities binds trimmed text literally and combines it with filters', () => {
  const uri = `at://${authorDid}/${ACTIVITY}/searched`;
  const row = activityRow({
    uri, cid: 'bafyreimmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',
    record: {
      title: 'Forest %_ Initiative', shortDescription: 'River monitoring', createdAt: indexedAt,
      contributors: [{ contributorIdentity: { identity: contributorDid } }],
    },
  });
  const profile = {
    uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE, cid: 'bafyreinnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    indexed_at: indexedAt, record: 'search-author-profile', record_json: { $type: PROFILE, displayName: 'Search author', createdAt: indexedAt },
  };
  const contributorProfile = {
    uri: `at://${contributorDid}/${PROFILE}/self`, did: contributorDid, collection: PROFILE, cid: 'bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    indexed_at: indexedAt, record: 'search-contributor-profile', record_json: { $type: PROFILE, displayName: 'Search contributor', createdAt: indexedAt },
  };
  const result = runLuaEndpoint({
    endpoint: 'searchActivities',
    params: { search: '  FOREST %_ Initiative  ', authors: [authorDid], limit: '10' },
    queryResults: [[row], [profile, contributorProfile], []],
    assertions: `
assert(#result.activities == 1 and result.activities[1].uri == '${uri}')
assert(result.activities[1].author.profile.record.displayName == 'Search author')
assert(result.activities[1].contributors[1].actor.profile.record.displayName == 'Search contributor')
local sql = calls[1].sql
assert(sql:find('strpos(lower', 1, true), 'search must use a literal substring comparison')
assert(not sql:find('LIKE', 1, true), 'search must not treat % or _ as wildcards')
assert(not sql:find('FOREST', 1, true), 'search text must be bound rather than interpolated')
local values = table.concat(calls[1].values, '|')
assert(values:find('FOREST %_ Initiative', 1, true), 'trimmed complete search text must remain a bound value')
assert(sql:find('activity.did IN', 1, true), 'authors filter must remain present with search')
assert(sql:find(' AND ', 1, true), 'search and authors must combine with AND')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listActivities authorType organization selects organization sidecars', () => {
  const result = runLuaEndpoint({
    endpoint: 'listActivities', params: { authorType: 'organization' }, queryResults: [[]],
    assertions: `
assert(#result.activities == 0 and result.cursor == nil)
assert(calls[1].sql:find("organization.collection = 'app.certified.actor.organization'", 1, true))
assert(not calls[1].sql:find('NOT EXISTS', 1, true))
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('activity listings use direction-bound tuple cursors and preserve empty results', () => {
  const beforeUri = `at://${authorDid}/${ACTIVITY}/before`;
  const cursor = Buffer.from(JSON.stringify({ v: 1, d: 'asc', t: '2025-01-01T00:00:00.000000Z', u: beforeUri })).toString('hex');
  const afterUri = `at://${authorDid}/${ACTIVITY}/after`;
  const after = activityRow({
    uri: afterUri, cid: 'bafyreioooooooooooooooooooooooooooooooooooooooooooooooooo',
    sortTimestamp: '2025-01-02T00:00:00.000000Z',
    record: { title: 'After cursor', shortDescription: 'Next page', createdAt: '2025-01-02T00:00:00Z' },
  });
  const profile = {
    uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE, cid: 'bafyreipppppppppppppppppppppppppppppppppppppppppppppppppp',
    indexed_at: indexedAt, record: 'cursor-author-profile', record_json: { $type: PROFILE, displayName: 'Cursor author', createdAt: indexedAt },
  };
  const page = runLuaEndpoint({
    endpoint: 'listActivities', params: { sortDirection: 'asc', cursor, limit: '1' },
    queryResults: [[after], [profile], []],
    assertions: `
assert(#result.activities == 1 and result.activities[1].uri == '${afterUri}')
assert(result.cursor == nil)
assert(calls[1].sql:find('(sorted.sort_at, activity.uri) >', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, activity.uri ASC', 1, true))
assert(calls[1].values[2] == '2025-01-01T00:00:00.000000Z')
assert(calls[1].values[3] == '${beforeUri}' and calls[1].values[4] == 2)
`,
  });
  assert.equal(page.status, 0, `${page.stderr}${page.stdout}`);

  const empty = runLuaEndpoint({
    endpoint: 'listActivities', params: {}, queryResults: [[]],
    assertions: `
assert(type(result.activities) == 'table' and #result.activities == 0 and result.cursor == nil)
assert(calls[1].values[1] == '${ACTIVITY}' and calls[1].values[2] == 26)
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, activity.uri DESC', 1, true))
assert(#calls == 1, 'an empty page must not trigger hydration')
`,
  });
  assert.equal(empty.status, 0, `${empty.stderr}${empty.stdout}`);
});

test('activity queries reject malformed filters and bounded-input violations before querying', () => {
  const badCursor = Buffer.from(JSON.stringify({ v: 1, d: 'desc', t: '2025-01-01T00:00:00Z', u: activityUri })).toString('hex');
  const invalidLists = [
    { search: 'forest' },
    { unknown: 'value' },
    { authors: ['alice.example'] },
    { authors: Array(101).fill(authorDid) },
    { contributors: ['did:plc:invalid:'] },
    { involvedActors: ['did:1:bad'] },
    { uris: ['at://alice.example/org.hypercerts.claim.activity/x'] },
    { uris: ['at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.certified.location/x'] },
    { authorType: 'group' },
    { limit: '0' },
    { limit: '101' },
    { limit: ['1', '2'] },
    { sortDirection: 'sideways' },
    { cursor: 'bad!' },
    { cursor: badCursor, sortDirection: 'asc' },
  ];
  for (const params of invalidLists) {
    const result = runLuaEndpoint({ endpoint: 'listActivities', params, queryResults: [], expectError: 'InvalidRequest:', expectedCalls: 0 });
    assert.equal(result.status, 0, `${JSON.stringify(params)}\n${result.stderr}${result.stdout}`);
  }
  const missingSearch = runLuaEndpoint({ endpoint: 'searchActivities', params: {}, queryResults: [], expectError: 'InvalidRequest:', expectedCalls: 0 });
  assert.equal(missingSearch.status, 0, `${missingSearch.stderr}${missingSearch.stdout}`);
  const unacceptedListSearch = runLuaEndpoint({ endpoint: 'listActivities', params: { search: 'forest' }, queryResults: [], expectError: 'InvalidRequest:', expectedCalls: 0 });
  assert.equal(unacceptedListSearch.status, 0, `${unacceptedListSearch.stderr}${unacceptedListSearch.stdout}`);
});

test('missing records, missing results, and operational activity-query failures stay distinct', () => {
  const missing = runLuaEndpoint({
    endpoint: 'getActivity', params: { uri: activityUri }, queryResults: [[]],
    expectError: 'RecordNotFound:', expectedCalls: 1,
  });
  assert.equal(missing.status, 0, `${missing.stderr}${missing.stdout}`);

  const listFailure = runLuaEndpoint({
    endpoint: 'listActivities', params: {}, queryResults: [], backend: 'sqlite',
    expectError: 'ActivityQueryFailed:', expectedCalls: 0,
  });
  assert.equal(listFailure.status, 0, `${listFailure.stderr}${listFailure.stdout}`);

  const row = activityRow({
    uri: `at://${authorDid}/${ACTIVITY}/hydration-failure`, cid: 'bafyreijjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj',
    record: { title: 'Hydration failure', shortDescription: 'Must not return partial data', createdAt: indexedAt },
  });
  const hydrationFailure = runLuaEndpoint({
    endpoint: 'listActivities', params: {}, queryResults: [[row]], queryFailureAt: 2,
    expectError: 'ActivityQueryFailed:', expectedCalls: 2,
  });
  assert.equal(hydrationFailure.status, 0, `${hydrationFailure.stderr}${hydrationFailure.stdout}`);
});

test('getActivity distinguishes absent contributors from an explicitly empty array', () => {
  const absent = structuredClone(activityRecord);
  delete absent.contributors;
  const absentResult = runGetActivity({
    uri: `at://${authorDid}/${ACTIVITY}/activity-without-contributors`,
    recordJson: absent,
    assertions: `assert(activity.record.contributors == nil and activity.contributors == nil)`,
  });
  assert.equal(absentResult.status, 0, `${absentResult.stderr}${absentResult.stdout}`);

  const empty = { ...activityRecord, contributors: [] };
  const emptyResult = runGetActivity({
    uri: `at://${authorDid}/${ACTIVITY}/activity-with-empty-contributors`,
    recordJson: empty,
    assertions: `assert(type(activity.record.contributors) == 'table' and #activity.record.contributors == 0)
assert(type(activity.contributors) == 'table' and #activity.contributors == 0)`,
  });
  assert.equal(emptyResult.status, 0, `${emptyResult.stderr}${emptyResult.stdout}`);
});
