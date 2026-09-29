import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const collection = 'org.hypercerts.funding.receipt';
const author = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const otherAuthor = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const senderDid = 'did:plc:cccccccccccccccccccccccc';
const recipientDid = 'did:plc:dddddddddddddddddddddddd';
const targetUri = 'at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.claim.activity/target';
const fromUri = 'at://did:plc:ffffffffffffffffffffffff/org.hypercerts.claim.activity/sender';
const toUri = 'at://did:plc:111111111111111111111111/org.hypercerts.claim.activity/recipient';
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

function receiptRow(did, rkey, record, sortTimestamp = '2025-01-01T00:00:00.000000Z') {
  return {
    uri: `at://${did}/${collection}/${rkey}`, did, cid: `bafy-${rkey}`, indexed_at: indexedAt,
    record: rkey, record_json: { $type: collection, ...record }, sort_timestamp: sortTimestamp,
  };
}

function cursor({ direction = 'desc', timestamp = '2025-01-02T03:04:05.000000Z', uri = `at://${author}/${collection}/cursor` } = {}) {
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
    if ${queryFailureAt} == #calls then error('fixture database failure') end
    return RESULTS[#calls] or {}
  end,
}
dofile('${endpointPath}')
local ok, result = pcall(handle)
${expectError
    ? `assert(not ok, 'expected ${endpoint} to reject params ${JSON.stringify(params)}')\nassert(tostring(result):find(${JSON.stringify(expectError)}, 1, true), tostring(result))\nassert(#calls == ${expectedCalls}, 'unexpected receipt query count')`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
}

test('funding receipt module declares both queries and keeps the package record schema as its single source', async () => {
  const modulePath = 'modules/funding/manifest.json';
  const module = JSON.parse(await readFile(`${root}/${modulePath}`, 'utf8'));
  const receiptLexicon = module.assets.find(({ id }) => id === collection);
  assert.ok(receiptLexicon, 'the package-backed receipt schema must be registered once');
  const queryIds = module.assets.filter(({ kind, id }) => kind === 'lexicon' &&
    ['org.hypercerts.funding.getReceipt', 'org.hypercerts.funding.listReceipts'].includes(id))
    .map(({ id }) => id).sort();
  assert.equal(module.assets.filter(({ kind, id }) => kind === 'lexicon' && id === collection).length, 1);
  assert.deepEqual(queryIds, ['org.hypercerts.funding.getReceipt', 'org.hypercerts.funding.listReceipts']);
  for (const name of ['getReceipt', 'listReceipts']) {
    const nsid = `org.hypercerts.funding.${name}`;
    const handler = module.assets.find(({ id }) => id === `xrpc.query:${nsid}`);
    assert.ok(handler, `missing handler declaration for ${nsid}`);
    assert.equal(handler.sourcePath, `../../lua/src/${name}.lua`);
    assert.ok(existsSync(`${root}/lua/endpoints/${name}.lua`), `missing generated handler for ${nsid}`);
  }
});

test('receipt query Lexicons expose the accepted filters and endpoint-local view shared by listReceipts', async () => {
  const getReceipt = JSON.parse(await readFile(`${root}/lexicons/org.hypercerts.funding.getReceipt.json`, 'utf8'));
  const listReceipts = JSON.parse(await readFile(`${root}/lexicons/org.hypercerts.funding.listReceipts.json`, 'utf8'));
  assert.deepEqual(getReceipt.defs.main.parameters.required, ['uri']);
  assert.equal(getReceipt.defs.main.parameters.properties.uri.format, 'at-uri');
  const view = getReceipt.defs.receiptView;
  assert.deepEqual(view.required, ['uri', 'cid', 'indexedAt', 'did', 'author', 'record']);
  assert.deepEqual(view.nullable, ['indexedAt']);
  assert.equal(view.properties.record.ref, collection);
  assert.equal(view.properties.author.ref, 'org.hypercerts.api.defs#actorView');
  assert.equal(getReceipt.defs.output.properties.receipt.ref, '#receiptView');
  assert.equal(listReceipts.defs.output.properties.receipts.items.ref, 'org.hypercerts.funding.getReceipt#receiptView');

  const properties = listReceipts.defs.main.parameters.properties;
  assert.deepEqual(Object.keys(properties).sort(), ['authors', 'cursor', 'forUris', 'from', 'limit', 'sortDirection', 'to', 'transactionIds', 'uris'].sort());
  for (const name of ['authors', 'uris', 'from', 'to', 'forUris', 'transactionIds']) assert.equal(properties[name].maxLength, 100);
  assert.equal(properties.from.items.type, 'string');
  assert.equal(properties.to.items.type, 'string');
  assert.equal(properties.sortDirection.enum.join(','), 'asc,desc');
  assert.equal(properties.limit.minimum, 1);
  assert.equal(properties.limit.maximum, 100);
});

test('getReceipt hydrates only the publisher and preserves the complete raw receipt including decimal amount', () => {
  const receipt = receiptRow(author, 'one', {
    from: { $type: 'app.certified.defs#did', did: senderDid }, to: { $type: 'org.hypercerts.funding.receipt#text', value: 'wallet:0xAB' },
    for: { uri: targetUri, cid: 'bafy-target' }, amount: '00012345678901234567890.00000001', transactionId: '0xAbC', rail: 'evm', network: 'chain-x',
  });
  const profile = { uri: `at://${author}/app.certified.actor.profile/self`, did: author, cid: 'bafy-profile', indexed_at: indexedAt, record: 'profile', record_json: { displayName: 'Publisher' } };
  runLua({
    endpoint: 'getReceipt', params: { uri: receipt.uri }, queryResults: [[receipt], [profile], []],
    assertions: `
assert(result.receipt.uri == '${receipt.uri}' and result.receipt.cid == '${receipt.cid}')
assert(result.receipt.did == '${author}' and result.receipt.indexedAt == '${indexedAt}')
assert(result.receipt.author.did == '${author}' and result.receipt.author.profile.record.displayName == 'Publisher')
assert(result.receipt.record.amount == '00012345678901234567890.00000001')
assert(result.receipt.record.from.did == '${senderDid}' and result.receipt.record.to.value == 'wallet:0xAB')
assert(result.receipt.record['for'].uri == '${targetUri}' and result.receipt.record.transactionId == '0xAbC')
assert(#calls == 3 and calls[1].values[1] == '${collection}' and calls[1].values[2] == '${receipt.uri}')
assert(calls[2].values[1] == 'app.certified.actor.profile' and calls[2].values[2] == '${author}')
assert(calls[3].values[1] == 'app.certified.actor.organization' and calls[3].values[2] == '${author}')
`,
  });
});

test('getReceipt and listReceipts preserve nil indexed_at as explicit JSON null', () => {
  const single = receiptRow(author, 'nil-indexed-at', { amount: '3', createdAt: '2025-01-01T00:00:00Z' });
  delete single.indexed_at;
  runLua({
    endpoint: 'getReceipt', params: { uri: single.uri }, queryResults: [[single], [], []],
    assertions: `
assert(result.receipt.indexedAt == NULL, 'getReceipt must include indexedAt as JSON null')
`,
  });

  const listed = receiptRow(author, 'nil-indexed-at-list', { amount: '4', createdAt: '2025-01-01T00:00:00Z' });
  delete listed.indexed_at;
  runLua({
    endpoint: 'listReceipts', params: {}, queryResults: [[listed], [], []],
    assertions: `
assert(#result.receipts == 1)
assert(result.receipts[1].indexedAt == NULL, 'listReceipts must include indexedAt as JSON null')
`,
  });
});

test('listReceipts applies mixed party variants and other filters with OR within arrays, AND across filters, and deduplicated binds', () => {
  const matching = receiptRow(author, 'matching', {
    from: { $type: 'app.certified.defs#did', did: senderDid }, to: { $type: 'com.atproto.repo.strongRef', uri: toUri, cid: 'stored-cid' },
    for: { uri: targetUri, cid: 'target-cid' }, transactionId: 'Tx-CaseSensitive', amount: '1.000000000000000001',
  });
  const lookahead = receiptRow(otherAuthor, 'lookahead', {
    from: { $type: 'com.atproto.repo.strongRef', uri: fromUri, cid: 'from-cid' }, to: { $type: 'app.certified.defs#did', did: recipientDid },
    for: { uri: targetUri, cid: 'new-target-cid' }, transactionId: 'Tx-CaseSensitive', amount: '9',
  }, '2025-01-02T03:04:05.000000Z');
  const profile = { uri: `at://${author}/app.certified.actor.profile/self`, did: author, cid: 'bafy-profile', indexed_at: indexedAt, record: 'profile', record_json: { displayName: 'Publisher' } };
  runLua({
    endpoint: 'listReceipts',
    params: {
      authors: [author, author], uris: [matching.uri, matching.uri],
      from: [senderDid, fromUri, senderDid], to: [toUri, recipientDid, toUri],
      forUris: [targetUri, targetUri], transactionIds: ['Tx-CaseSensitive', 'Tx-CaseSensitive'], sortDirection: 'asc', limit: '1',
    },
    queryResults: [[matching, lookahead], [profile], []],
    assertions: `
assert(#result.receipts == 1 and result.receipts[1].uri == '${matching.uri}')
assert(result.receipts[1].record.amount == '1.000000000000000001')
assert(calls[1].values[1] == '${collection}')
assert(calls[1].sql:find("receipt.record::jsonb->'from'->>'$type' = 'app.certified.defs#did'", 1, true), calls[1].sql)
assert(calls[1].sql:find("receipt.record::jsonb->'from'->>'$type' = 'com.atproto.repo.strongRef'", 1, true), calls[1].sql)
assert(calls[1].sql:find("receipt.record::jsonb->'to'->>'$type' = 'app.certified.defs#did'", 1, true), calls[1].sql)
assert(calls[1].sql:find("receipt.record::jsonb->'to'->>'$type' = 'com.atproto.repo.strongRef'", 1, true), calls[1].sql)
assert(calls[1].sql:find("receipt.record::jsonb->'for'->>'uri'", 1, true), calls[1].sql)
assert(calls[1].sql:find("receipt.record::jsonb->>'transactionId'", 1, true), calls[1].sql)
assert(calls[1].sql:find('receipt.did IN', 1, true) and calls[1].sql:find('receipt.uri IN', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, receipt.uri ASC', 1, true))
assert(calls[1].values[2] == '${author}' and calls[1].values[3] == '${matching.uri}')
assert(calls[1].values[4] == '${senderDid}' and calls[1].values[5] == '${fromUri}')
assert(calls[1].values[6] == '${recipientDid}' and calls[1].values[7] == '${toUri}')
assert(calls[1].values[8] == '${targetUri}' and calls[1].values[9] == 'Tx-CaseSensitive')
assert(#calls[1].values == 10 and calls[1].values[10] == 2, 'duplicates must be removed before binding')
assert(calls[2].values[1] == 'app.certified.actor.profile' and calls[2].values[2] == '${author}')
assert(calls[3].values[1] == 'app.certified.actor.organization' and calls[3].values[2] == '${author}')
assert(#calls == 3, 'the lookahead receipt must not trigger author hydration')
`,
  });
});

test('listReceipts rejects invalid mixed party entries before querying and binds cursors to sort direction', () => {
  runLua({ endpoint: 'listReceipts', params: { from: [senderDid, 'alice.example'] }, expectError: 'alice.example', expectedCalls: 0 });
  runLua({ endpoint: 'listReceipts', params: { to: ['not-an-identifier'] }, expectError: 'not-an-identifier', expectedCalls: 0 });
  const row = receiptRow(author, 'after-cursor', { amount: '2' });
  runLua({
    endpoint: 'listReceipts', params: { sortDirection: 'desc', cursor: cursor({ direction: 'desc' }), limit: '1' },
    queryResults: [[row], []],
    assertions: `
assert(calls[1].sql:find('(sorted.sort_at, receipt.uri) <', 1, true))
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, receipt.uri DESC', 1, true))
assert(calls[1].values[2] == '2025-01-02T03:04:05.000000Z')
assert(calls[1].values[3] == 'at://${author}/${collection}/cursor')
assert(calls[1].values[4] == 2)
`,
  });
  runLua({ endpoint: 'listReceipts', params: { sortDirection: 'asc', cursor: cursor({ direction: 'desc' }) }, expectError: 'InvalidRequest:', expectedCalls: 0 });
});

test('listReceipts rejects malformed collection NSIDs in mixed party and funded-target AT-URIs before SQL', () => {
  const malformedCollectionUri = `at://${senderDid}/x/rkey`;
  runLua({
    endpoint: 'listReceipts', params: { from: [malformedCollectionUri] },
    expectError: `from entry "${malformedCollectionUri}" must be a valid DID or full record AT-URI; resolve handles to DIDs before querying`, expectedCalls: 0,
  });
  runLua({
    endpoint: 'listReceipts', params: { to: [malformedCollectionUri] },
    expectError: `to entry "${malformedCollectionUri}" must be a valid DID or full record AT-URI; resolve handles to DIDs before querying`, expectedCalls: 0,
  });
  runLua({
    endpoint: 'listReceipts', params: { forUris: [malformedCollectionUri] },
    expectError: `forUris entry "${malformedCollectionUri}" must be a full record AT-URI with a valid NSID collection and DID authority`, expectedCalls: 0,
  });
});

test('listReceipts bounds raw array length, rejects unsupported params, and reports indexed misses and database errors', () => {
  runLua({ endpoint: 'listReceipts', params: { authors: Array(101).fill(author) }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listReceipts', params: { mystery: 'value' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'listReceipts', params: { limit: '101' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'getReceipt', params: { uri: 'not-an-at-uri' }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'getReceipt', params: { uri: `at://${author}/org.hypercerts.claim.activity/not-a-receipt` }, expectError: 'InvalidRequest:', expectedCalls: 0 });
  runLua({ endpoint: 'getReceipt', params: { uri: `at://${author}/${collection}/missing` }, queryResults: [[]], expectError: 'RecordNotFound:', expectedCalls: 1 });
  runLua({ endpoint: 'listReceipts', params: {}, backend: 'sqlite', expectError: 'ReceiptQueryFailed:', expectedCalls: 0 });
  runLua({ endpoint: 'getReceipt', params: { uri: `at://${author}/${collection}/failure` }, queryFailureAt: 1, expectError: 'ReceiptQueryFailed:', expectedCalls: 1 });
});
