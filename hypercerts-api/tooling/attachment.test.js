import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ATTACHMENT = 'org.hypercerts.context.attachment';
const PROFILE = 'app.certified.actor.profile';
const ORGANIZATION = 'app.certified.actor.organization';
const author = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const anotherAuthor = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const indexedAt = '2025-01-02T03:04:05.000Z';
const firstUri = `at://${author}/${ATTACHMENT}/3jzfcijpj2z2a`;
const secondUri = `at://${anotherAuthor}/${ATTACHMENT}/3jzfcijpj2z2b`;
const subjectUri = `at://${author}/org.hypercerts.claim.activity/3jzfcijpj2z2c`;
const otherSubjectUri = `at://${author}/org.hypercerts.context.attachment/3jzfcijpj2z2d`;
const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

function attachmentRow({
  uri = firstUri,
  did = uri.match(/^at:\/\/([^/]+)/)[1],
  title = 'Evidence attachment',
  contentType = 'evidence',
  subjects = [{ uri: subjectUri, cid }],
  sortTimestamp = '2025-01-01T00:00:00.000000Z',
  indexedAtValue = indexedAt,
} = {}) {
  const recordJson = {
    $type: ATTACHMENT,
    title,
    createdAt: '2025-01-01T00:00:00Z',
    contentType,
    subjects,
    content: [{ $type: 'org.hypercerts.defs#uri', uri: 'https://example.test/report.pdf' }],
  };
  return {
    uri, did, cid, indexed_at: indexedAtValue,
    record: uri, record_json: recordJson, sort_timestamp: sortTimestamp,
  };
}

function sidecarRow(collection, did, id, record) {
  return {
    uri: `at://${did}/${collection}/self`, did, cid: `bafy-${id}`, indexed_at: indexedAt,
    record: id, record_json: { $type: collection, ...record },
  };
}

function cursor({ direction = 'desc', timestamp = '2025-01-02T03:04:05.000000Z', uri = firstUri } = {}) {
  return Buffer.from(JSON.stringify({ v: 1, d: direction, t: timestamp, u: uri }), 'utf8').toString('hex');
}

function runLua({
  endpoint,
  params,
  queryResults = [],
  assertions = '',
  expectError,
  expectedCalls = 0,
  backend = 'postgres',
  queryFailureAt = 0,
}) {
  const endpointPath = `lua/endpoints/${endpoint}.lua`;
  assert.ok(existsSync(`${root}/${endpointPath}`), `${endpointPath} must be generated before exercising the handler`);
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
    if ${queryFailureAt} == #calls then error('fixture database failure') end
    return RESULTS[#calls] or {}
  end,
}
dofile('${endpointPath}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected handler to reject the request')\nassert(tostring(result):find(${JSON.stringify(expectError)}, 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  return spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
}

function assertLuaPass(result) {
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
}

test('attachment module registers one package record and both local query handlers', async () => {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  const modulePath = 'modules/context-attachments/manifest.json';
  assert.ok(manifest.modules.includes(modulePath));
  assert.deepEqual({
    getAttachment: manifest.handlerStatus.getAttachment,
    listAttachments: manifest.handlerStatus.listAttachments,
  }, { getAttachment: 'implemented', listAttachments: 'implemented' });

  const modules = await Promise.all(manifest.modules.map(async (path) => JSON.parse(await readFile(`${root}/${path}`, 'utf8'))));
  const recordAssets = modules.flatMap(({ assets }) => assets.filter(({ kind, id }) => kind === 'lexicon' && id === ATTACHMENT));
  assert.equal(recordAssets.length, 1, 'the package-backed attachment record Lexicon must be registered exactly once');
  assert.equal(recordAssets[0].packagePath, 'lexicons/org/hypercerts/context/attachment.json');
  assert.equal(recordAssets[0].config.backfill, true);
  assert.equal(manifest.validationLexicons.filter(({ id }) => id === ATTACHMENT).length, 1);
  assert.deepEqual(manifest.validationLexicons.find(({ id }) => id === ATTACHMENT), {
    id: ATTACHMENT,
    packagePath: 'lexicons/org/hypercerts/context/attachment.json',
  });

  const module = JSON.parse(await readFile(`${root}/${modulePath}`, 'utf8'));
  const schemas = new Map();
  for (const name of ['getAttachment', 'listAttachments']) {
    const nsid = `org.hypercerts.context.${name}`;
    const schema = JSON.parse(await readFile(`${root}/lexicons/${nsid}.json`, 'utf8'));
    schemas.set(name, schema);
    assert.equal(schema.id, nsid);
    assert.equal(manifest.validationLexicons.filter(({ id }) => id === nsid).length, 1);
    assert.ok(module.assets.some(({ kind, id }) => kind === 'lexicon' && id === nsid && id !== ATTACHMENT));
    const script = module.assets.find(({ kind, id }) => kind === 'script' && id === `xrpc.query:${nsid}`);
    assert.ok(script, `missing handler declaration for ${nsid}`);
    assert.equal(script.sourcePath, `../../lua/src/${name}.lua`);
    assert.ok(manifest.luaBuild.endpointSources.includes(`lua/src/${name}.lua`));
  }
  const getSchema = schemas.get('getAttachment');
  const listSchema = schemas.get('listAttachments');
  assert.deepEqual(getSchema.defs.main.parameters.required, ['uri']);
  assert.equal(getSchema.defs.main.parameters.properties.uri.format, 'at-uri');
  assert.deepEqual(getSchema.defs.attachmentView.required, ['uri', 'cid', 'indexedAt', 'did', 'author', 'record']);
  assert.deepEqual(getSchema.defs.attachmentView.nullable, ['indexedAt']);
  assert.equal(getSchema.defs.attachmentView.properties.author.ref, 'org.hypercerts.api.defs#actorView');
  assert.equal(getSchema.defs.attachmentView.properties.record.ref, ATTACHMENT);
  assert.equal(getSchema.defs.output.properties.attachment.ref, '#attachmentView');
  assert.deepEqual(Object.keys(listSchema.defs.main.parameters.properties).sort(), [
    'authors', 'contentTypes', 'cursor', 'limit', 'sortDirection', 'subjects', 'uris',
  ]);
  for (const key of ['authors', 'uris', 'subjects', 'contentTypes']) {
    assert.equal(listSchema.defs.main.parameters.properties[key].maxLength, 100);
  }
  assert.equal(listSchema.defs.main.parameters.properties.contentTypes.items.type, 'string');
  assert.equal(listSchema.defs.main.parameters.properties.limit.minimum, 1);
  assert.equal(listSchema.defs.main.parameters.properties.limit.maximum, 100);
  assert.equal(listSchema.defs.output.properties.attachments.items.ref, 'org.hypercerts.context.getAttachment#attachmentView');
  assert.equal(manifest.validationLexicons.some(({ id }) => id === 'org.hypercerts.api.defs'), true);
});

test('getAttachment uses exact URI lookup, preserves the record, and returns null for missing author sidecars', () => {
  const result = runLua({
    endpoint: 'getAttachment', params: { uri: firstUri },
    queryResults: [[attachmentRow({ indexedAtValue: null })], [], []],
    assertions: `
assert(result.attachment.uri == '${firstUri}')
assert(result.attachment.indexedAt == NULL and result.attachment.indexedAt ~= nil)
assert(result.attachment.did == '${author}' and result.attachment.cid == '${cid}')
assert(result.attachment.author.did == '${author}')
assert(result.attachment.author.profile == NULL and result.attachment.author.organization == NULL)
assert(result.attachment.record['$type'] == '${ATTACHMENT}' and result.attachment.record.title == 'Evidence attachment')
assert(result.attachment.record.subjects[1].uri == '${subjectUri}' and result.attachment.record.subjects[1].cid == '${cid}')
assert(result.attachment.record.content[1].uri == 'https://example.test/report.pdf')
assert(calls[1].values[1] == '${ATTACHMENT}' and calls[1].values[2] == '${firstUri}')
assert(calls[1].sql:find('collection = $1 AND uri = $2', 1, true), calls[1].sql)
assert(calls[2].values[1] == '${PROFILE}' and calls[2].values[2] == '${author}')
assert(calls[3].values[1] == '${ORGANIZATION}' and calls[3].values[2] == '${author}')
assert(#calls == 3)
`,
  });
  assertLuaPass(result);
});

test('getAttachment hydrates both available publisher sidecars through ActorView', () => {
  const profile = sidecarRow(PROFILE, author, 'profile', { displayName: 'Publisher' });
  const organization = sidecarRow(ORGANIZATION, author, 'organization', { organizationType: ['nonprofit'] });
  const result = runLua({
    endpoint: 'getAttachment', params: { uri: firstUri },
    queryResults: [[attachmentRow({})], [profile], [organization]],
    assertions: `
assert(result.attachment.author.profile.uri == '${profile.uri}')
assert(result.attachment.author.profile.record.displayName == 'Publisher')
assert(result.attachment.author.organization.uri == '${organization.uri}')
assert(result.attachment.author.organization.record.organizationType[1] == 'nonprofit')
`,
  });
  assertLuaPass(result);
});

test('listAttachments ANDs filters, ORs and deduplicates values, and matches any subject URI without CID', () => {
  const first = attachmentRow({ title: 'First page', indexedAtValue: null });
  const lookahead = attachmentRow({
    uri: secondUri, title: 'Lookahead', contentType: 'audio',
    subjects: [{ uri: otherSubjectUri, cid: 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    sortTimestamp: '2025-01-02T00:00:00.000000Z',
  });
  const profile = sidecarRow(PROFILE, author, 'profile', { displayName: 'Publisher' });
  const result = runLua({
    endpoint: 'listAttachments',
    params: {
      authors: [author, author],
      uris: [firstUri, firstUri],
      subjects: [subjectUri, otherSubjectUri, subjectUri],
      contentTypes: ['evidence', 'audio', 'evidence'],
      sortDirection: 'asc', limit: '1',
    },
    queryResults: [[first, lookahead], [profile], []],
    assertions: `
assert(#result.attachments == 1 and result.attachments[1].uri == '${firstUri}')
assert(result.attachments[1].indexedAt == NULL and result.attachments[1].indexedAt ~= nil)
assert(result.attachments[1].author.profile.record.displayName == 'Publisher')
assert(result.attachments[1].author.organization == NULL)
assert(result.attachments[1].record.subjects[1].uri == '${subjectUri}' and result.attachments[1].record.subjects[1].cid == '${cid}')
local sql, values = calls[1].sql, calls[1].values
assert(sql:find('attachment.did IN ($2)', 1, true), sql)
assert(sql:find('attachment.uri IN ($3)', 1, true), sql)
assert(sql:find('jsonb_array_elements', 1, true) and sql:find("subject.value->>'uri'", 1, true), sql)
assert(not sql:find("subject.value->>'cid'", 1, true), sql)
assert(sql:find("attachment.record::jsonb->>'contentType' IN", 1, true), sql)
assert(sql:find(' ORDER BY sorted.sort_at ASC, attachment.uri ASC', 1, true), sql)
assert(values[1] == '${ATTACHMENT}' and values[2] == '${author}' and values[3] == '${firstUri}')
assert(values[4] == '${subjectUri}' and values[5] == '${otherSubjectUri}')
assert(values[6] == 'evidence' and values[7] == 'audio')
assert(values[#values] == 2, 'request one extra row to determine whether a next page exists')
assert(#calls == 3, 'only the returned page is hydrated')
local decoded = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(decoded)
assert(token.v == 1 and token.d == 'asc' and token.t == '${first.sort_timestamp}' and token.u == '${firstUri}')
assert(calls[2].values[1] == '${PROFILE}' and calls[2].values[2] == '${author}')
`,
  });
  assertLuaPass(result);
});

test('listAttachments uses stable direction-bound tuple cursors and rejects a cursor from the other direction', () => {
  const row = attachmentRow({ uri: secondUri, title: 'After cursor' });
  const result = runLua({
    endpoint: 'listAttachments', params: { sortDirection: 'desc', cursor: cursor({ direction: 'desc' }), limit: '1' },
    queryResults: [[row], [], []],
    assertions: `
assert(#result.attachments == 1 and result.cursor == nil)
assert(calls[1].sql:find('(sorted.sort_at, attachment.uri) <', 1, true), calls[1].sql)
assert(calls[1].sql:find(' ORDER BY sorted.sort_at DESC, attachment.uri DESC', 1, true), calls[1].sql)
assert(calls[1].values[2] == '2025-01-02T03:04:05.000000Z')
assert(calls[1].values[3] == '${firstUri}')
assert(calls[1].values[#calls[1].values] == 2)
`,
  });
  assertLuaPass(result);
  assertLuaPass(runLua({ endpoint: 'listAttachments', params: { sortDirection: 'asc', cursor: cursor({ direction: 'desc' }) }, expectError: 'InvalidRequest:', expectedCalls: 0 }));
});

test('listAttachments defaults to 25 results in descending order', () => {
  const result = runLua({
    endpoint: 'listAttachments', params: {}, queryResults: [[attachmentRow({})], [], []],
    assertions: `
assert(#result.attachments == 1)
assert(calls[1].values[2] == 26)
assert(calls[1].sql:find(' ORDER BY sorted.sort_at DESC, attachment.uri DESC', 1, true), calls[1].sql)
`,
  });
  assertLuaPass(result);
});

test('attachment lookup and listing reject invalid or unbounded inputs before querying', () => {
  for (const params of [
    { uri: `at://${author}/org.hypercerts.claim.activity/3jzfcijpj2z2a` },
    { uri: [firstUri, firstUri] },
    { unknown: 'value' },
  ]) {
    assertLuaPass(runLua({ endpoint: 'getAttachment', params, expectError: 'InvalidRequest:', expectedCalls: 0 }));
  }
  for (const params of [
    { unknown: 'value' },
    { authors: Array(101).fill(author) },
    { uris: Array(101).fill(firstUri) },
    { subjects: Array(101).fill(subjectUri) },
    { contentTypes: Array(101).fill('evidence') },
    { limit: '0' },
    { limit: '101' },
    { limit: ['1', '2'] },
    { sortDirection: 'sideways' },
  ]) {
    assertLuaPass(runLua({ endpoint: 'listAttachments', params, expectError: 'InvalidRequest:', expectedCalls: 0 }));
  }
});

test('attachment misses and query or author-hydration failures remain errors, not nullable sidecars', () => {
  assertLuaPass(runLua({ endpoint: 'getAttachment', params: { uri: firstUri }, queryResults: [[]], expectError: 'RecordNotFound:', expectedCalls: 1 }));
  assertLuaPass(runLua({ endpoint: 'getAttachment', params: { uri: firstUri }, backend: 'sqlite', expectError: 'AttachmentQueryFailed:', expectedCalls: 0 }));
  assertLuaPass(runLua({ endpoint: 'getAttachment', params: { uri: firstUri }, queryResults: [[attachmentRow({})], []], queryFailureAt: 2, expectError: 'AttachmentQueryFailed:', expectedCalls: 2 }));
  assertLuaPass(runLua({ endpoint: 'listAttachments', params: {}, queryResults: [[attachmentRow({})], []], queryFailureAt: 2, expectError: 'AttachmentQueryFailed:', expectedCalls: 2 }));
});
