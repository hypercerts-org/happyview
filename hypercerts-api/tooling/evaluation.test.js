import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const EVALUATION = 'org.hypercerts.context.evaluation';
const PROFILE = 'app.certified.actor.profile';
const ORGANIZATION = 'app.certified.actor.organization';
const authorDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const evaluatorDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const missingDid = 'did:plc:cccccccccccccccccccccccccccc';
const omittedDid = 'did:plc:dddddddddddddddddddddddddddd';
const lookaheadEvaluatorDid = 'did:plc:999999999999999999999999';
const evaluationUri = `at://${authorDid}/${EVALUATION}/review-one`;
const subjectUri = 'at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.claim.activity/activity-one';
const createdAt = '2025-01-02T03:04:05Z';
const evaluationRecord = {
  $type: EVALUATION,
  evaluators: [
    { did: evaluatorDid }, { did: evaluatorDid }, { did: missingDid },
    ...Array.from({ length: 97 }, () => ({ did: evaluatorDid })), { did: omittedDid },
  ],
  summary: 'Original evaluation summary',
  createdAt,
  subject: { uri: subjectUri, cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  score: { min: '0', max: '5', value: '3.75' },
  extension: { preserve: true },
};

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

function databaseRow(row) {
  const result = { ...row };
  delete result.record_json;
  return result;
}

const evaluationRow = {
  uri: evaluationUri,
  did: authorDid,
  collection: EVALUATION,
  cid: 'bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff',
  indexed_at: createdAt,
  record: 'evaluation-record',
  record_json: evaluationRecord,
};

const authorProfile = {
  uri: `at://${authorDid}/${PROFILE}/self`, did: authorDid, collection: PROFILE,
  cid: 'bafyreigggggggggggggggggggggggggggggggggggggggggggggggggg', indexed_at: createdAt,
  record: 'author-profile', record_json: { $type: PROFILE, displayName: 'Evaluation publisher', createdAt },
};
const evaluatorProfile = {
  uri: `at://${evaluatorDid}/${PROFILE}/self`, did: evaluatorDid, collection: PROFILE,
  cid: 'bafyreihhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh', indexed_at: createdAt,
  record: 'evaluator-profile', record_json: { $type: PROFILE, displayName: 'Named evaluator', createdAt },
};
const evaluatorOrganization = {
  uri: `at://${evaluatorDid}/${ORGANIZATION}/self`, did: evaluatorDid, collection: ORGANIZATION,
  cid: 'bafyreijjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj', indexed_at: createdAt,
  record: 'evaluator-organization', record_json: { $type: ORGANIZATION, organizationType: ['nonprofit'], createdAt },
};

function runLua({ endpoint, params, queryResults, assertions = '', expectError, backend = 'postgres', queryFailureAt = 0 }) {
  const rows = queryResults.flat();
  const records = Object.fromEntries(rows.map(({ record, record_json }) => [record, record_json]));
  const databaseResults = queryResults.map((result) => result.map(databaseRow));
  const source = `
local RECORDS = ${lua(records)}
local RESULTS = ${lua(databaseResults)}
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
    ? `assert(not ok, 'expected request to fail')\nassert(tostring(result):find('${expectError}', 1, true), tostring(result))`
    : `assert(ok, tostring(result))\n${assertions}`}
`;
  return spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
}

test('getEvaluation preserves the complete record and evaluator positions while hydrating only the first 100', () => {
  const result = runLua({
    endpoint: 'getEvaluation',
    params: { uri: evaluationUri },
    queryResults: [[evaluationRow], [authorProfile, evaluatorProfile], [evaluatorOrganization]],
    assertions: `
local view = result.evaluation
assert(view.uri == '${evaluationUri}' and view.did == '${authorDid}')
assert(view.record.summary == 'Original evaluation summary' and view.record.score.value == '3.75')
assert(view.record.subject.uri == '${subjectUri}' and view.record.extension.preserve == true)
assert(#view.record.evaluators == 101 and view.record.evaluators[1].did == '${evaluatorDid}' and view.record.evaluators[2].did == '${evaluatorDid}')
assert(view.record.evaluators[1].hydrationStatus == nil)
assert(#view.evaluators == 101 and view.evaluators[1].did == '${evaluatorDid}' and view.evaluators[2].did == '${evaluatorDid}')
assert(view.evaluators[1].hydrationStatus == 'hydrated')
assert(view.evaluators[1].profile.record.displayName == 'Named evaluator')
assert(view.evaluators[1].organization.record.organizationType[1] == 'nonprofit')
assert(view.evaluators[2].did == '${evaluatorDid}' and view.evaluators[2].hydrationStatus == 'hydrated')
assert(view.evaluators[3].did == '${missingDid}' and view.evaluators[3].profile == NULL and view.evaluators[3].organization == NULL)
assert(view.evaluators[101].did == '${omittedDid}' and view.evaluators[101].hydrationStatus == 'omitted')
assert(view.evaluators[101].profile == nil and view.evaluators[101].organization == nil)
assert(view.author.did == '${authorDid}' and view.author.profile.record.displayName == 'Evaluation publisher')
assert(view.author.organization == NULL)
assert(#calls == 3, 'one exact lookup and one bulk lookup for each Certified collection')
local profile_values = table.concat(calls[2].values, '|')
assert(profile_values:find('${authorDid}', 1, true) and profile_values:find('${evaluatorDid}', 1, true))
assert(profile_values:find('${missingDid}', 1, true) and not profile_values:find('${omittedDid}', 1, true))
assert(#calls[2].values == 4 and #calls[3].values == 4, 'identity lookups deduplicate evaluator DIDs')
assert(calls[1].values[1] == '${EVALUATION}' and calls[1].values[2] == '${evaluationUri}')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations skips an invalid evaluator row and paginates through later valid records', () => {
  const bad = {
    ...evaluationRow, uri: `at://${authorDid}/${EVALUATION}/bad`, record: 'bad-evaluation',
    record_json: { ...evaluationRecord, evaluators: [{ did: 'not-a-did' }] },
    sort_timestamp: '2025-01-03T00:00:00.000000Z',
  };
  const good = {
    ...evaluationRow, uri: `at://${authorDid}/${EVALUATION}/good`, record: 'good-evaluation',
    sort_timestamp: '2025-01-02T00:00:00.000000Z',
  };
  const last = {
    ...evaluationRow, uri: `at://${authorDid}/${EVALUATION}/last`, record: 'last-evaluation',
    sort_timestamp: '2025-01-01T00:00:00.000000Z',
  };
  const result = runLua({
    endpoint: 'listEvaluations', params: { limit: '1' },
    queryResults: [[bad, good], [good, last], [authorProfile, evaluatorProfile], [evaluatorOrganization], [last], [authorProfile, evaluatorProfile], [evaluatorOrganization]],
    assertions: `
assert(#result.evaluations == 1 and result.evaluations[1].uri == '${good.uri}')
assert(result.cursor ~= nil, 'cursor continues after the valid row')
local cursor = json.decode(result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end))
assert(cursor.u == '${good.uri}')
params.cursor = result.cursor
local next_page = handle()
assert(#next_page.evaluations == 1 and next_page.evaluations[1].uri == '${last.uri}' and next_page.cursor == nil)
assert(calls[2].values[2] == '${bad.sort_timestamp}' and calls[2].values[3] == '${bad.uri}')
assert(calls[5].values[2] == '${good.sort_timestamp}' and calls[5].values[3] == '${good.uri}')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations bounds scans of consecutive invalid rows and returns a continuation cursor', () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    ...evaluationRow,
    uri: `at://${authorDid}/${EVALUATION}/bad-${index}`,
    record: `bad-evaluation-${index}`,
    record_json: { ...evaluationRecord, evaluators: [{ did: 'not-a-did' }] },
    sort_timestamp: `2025-01-01T00:00:${String(59 - index).padStart(2, '0')}.000000Z`,
  }));
  const queryResults = Array.from({ length: 10 }, (_, index) => [rows[index], rows[index + 1]]);
  const result = runLua({
    endpoint: 'listEvaluations', params: { limit: '1' }, queryResults,
    assertions: `
assert(#result.evaluations == 0 and result.cursor ~= nil)
assert(#calls == 10, 'stop after ten query batches instead of scanning indefinitely')
local token = json.decode(result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end))
assert(token.u == '${rows[9].uri}', 'continuation cursor must advance past the last inspected row')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations accepts 100 entries per filter and a 100-record page', () => {
  const result = runLua({
    endpoint: 'listEvaluations',
    params: {
      authors: Array(100).fill(authorDid),
      evaluators: Array(100).fill(evaluatorDid),
      subjects: Array(100).fill(subjectUri),
      limit: '100',
    },
    queryResults: [[]],
    assertions: `
assert(#result.evaluations == 0 and result.cursor == nil)
assert(#calls[1].values == 5 and calls[1].values[5] == 101)
assert(calls[1].sql:find('evaluation.did IN ($2)', 1, true))
assert(calls[1].sql:find("evaluator.value->>'did' IN ($3)", 1, true))
assert(calls[1].sql:find("evaluation.record::jsonb->'subject'->>'uri' IN ($4)", 1, true))
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations combines OR-within/AND-across filters and matches evaluators past position 100', () => {
  const row = { ...evaluationRow, record: 'filtered-evaluation' };
  const otherAuthor = 'did:plc:ffffffffffffffffffffffff';
  const otherSubject = 'at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.claim.activity/activity-two';
  const result = runLua({
    endpoint: 'listEvaluations',
    params: {
      authors: [authorDid, authorDid, otherAuthor],
      evaluators: [omittedDid, omittedDid, evaluatorDid],
      subjects: [subjectUri, otherSubject, subjectUri],
      sortDirection: 'asc',
      limit: '10',
    },
    queryResults: [[row], [authorProfile, evaluatorProfile], [evaluatorOrganization]],
    assertions: `
assert(#result.evaluations == 1 and result.evaluations[1].uri == '${evaluationUri}')
assert(result.evaluations[1].record.evaluators[101].did == '${omittedDid}')
assert(result.evaluations[1].evaluators[101].did == '${omittedDid}' and result.evaluations[1].evaluators[101].hydrationStatus == 'omitted')
local sql = calls[1].sql
assert(sql:find('evaluation.did IN ($2, $3)', 1, true), 'authors use OR and duplicate input DIDs are removed')
assert(sql:find('jsonb_array_elements(', 1, true) and sql:find("evaluator.value->>'did' IN ($4, $5)", 1, true),
  'evaluator filtering inspects every original DID object, not only hydrated positions')
assert(sql:find("evaluation.record::jsonb->'subject'->>'uri' IN ($6, $7)", 1, true),
  'subjects match their original strong-reference URI values')
assert(sql:find(' AND ', 1, true), 'different filters combine with AND')
assert(calls[1].values[4] == '${omittedDid}' and calls[1].values[5] == '${evaluatorDid}')
local hydrated_dids = table.concat(calls[2].values, '|')
assert(not hydrated_dids:find('${omittedDid}', 1, true), 'entries beyond position 100 are filtered but not hydrated')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations orders by createdAt and URI and emits a direction-bound cursor from the last returned row', () => {
  const firstUri = `at://${authorDid}/${EVALUATION}/first`;
  const lookaheadUri = `at://${authorDid}/${EVALUATION}/lookahead`;
  const first = {
    ...evaluationRow, uri: firstUri, record: 'first-evaluation',
    sort_timestamp: '2025-01-01T00:00:00.000000Z',
  };
  const lookaheadRecord = { ...evaluationRecord, evaluators: [{ did: lookaheadEvaluatorDid }] };
  const lookahead = {
    ...evaluationRow, uri: lookaheadUri, record: 'lookahead-evaluation', record_json: lookaheadRecord,
    sort_timestamp: '2025-01-02T00:00:00.000000Z',
  };
  const result = runLua({
    endpoint: 'listEvaluations',
    params: { sortDirection: 'asc', limit: '1' },
    queryResults: [[first, lookahead], [authorProfile, evaluatorProfile], [evaluatorOrganization]],
    assertions: `
assert(#result.evaluations == 1 and result.evaluations[1].uri == '${firstUri}')
assert(result.cursor ~= nil)
local cursor_json = result.cursor:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
local token = json.decode(cursor_json)
assert(token.v == 1 and token.d == 'asc' and token.t == '2025-01-01T00:00:00.000000Z' and token.u == '${firstUri}')
assert(calls[1].sql:find('ORDER BY sorted.sort_at ASC, evaluation.uri ASC', 1, true))
assert(not table.concat(calls[2].values, '|'):find('${lookaheadEvaluatorDid}', 1, true), 'lookahead rows are not hydrated')
`,
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listEvaluations applies an ascending tuple cursor and rejects cursors bound to another direction', () => {
  const beforeUri = `at://${authorDid}/${EVALUATION}/before`;
  const afterUri = `at://${authorDid}/${EVALUATION}/after`;
  const cursor = Buffer.from(JSON.stringify({
    v: 1, d: 'asc', t: '2025-01-01T00:00:00.000000Z', u: beforeUri,
  })).toString('hex');
  const after = {
    ...evaluationRow, uri: afterUri, record: 'after-evaluation',
    sort_timestamp: '2025-01-02T00:00:00.000000Z',
  };
  const page = runLua({
    endpoint: 'listEvaluations',
    params: { sortDirection: 'asc', cursor, limit: '1' },
    queryResults: [[after], [authorProfile, evaluatorProfile], [evaluatorOrganization]],
    assertions: `
assert(#result.evaluations == 1 and result.evaluations[1].uri == '${afterUri}' and result.cursor == nil)
assert(calls[1].sql:find('(sorted.sort_at, evaluation.uri) >', 1, true))
assert(calls[1].values[2] == '2025-01-01T00:00:00.000000Z' and calls[1].values[3] == '${beforeUri}')
assert(calls[1].values[4] == 2)
`,
  });
  assert.equal(page.status, 0, `${page.stderr}${page.stdout}`);

  const mismatched = runLua({
    endpoint: 'listEvaluations',
    params: { sortDirection: 'desc', cursor },
    queryResults: [],
    expectError: 'InvalidRequest:',
  });
  assert.equal(mismatched.status, 0, `${mismatched.stderr}${mismatched.stdout}`);
});

test('listEvaluations rejects invalid filters and separates database failures from empty results', () => {
  const malformed = [
    { unknown: 'value' },
    { authors: ['alice.example'] },
    { authors: Array(101).fill(authorDid) },
    { evaluators: ['did:plc:invalid:'] },
    { subjects: ['at://alice.example/org.hypercerts.claim.activity/x'] },
    { subjects: [`at://${authorDid}/notnsid/x`] },
    { subjects: ['not-an-at-uri'] },
    { limit: '0' },
    { limit: '101' },
    { limit: ['1', '2'] },
    { sortDirection: 'sideways' },
    { cursor: 'not-hex' },
  ];
  for (const params of malformed) {
    const invalid = runLua({ endpoint: 'listEvaluations', params, queryResults: [], expectError: 'InvalidRequest:' });
    assert.equal(invalid.status, 0, `${JSON.stringify(params)}\n${invalid.stderr}${invalid.stdout}`);
  }

  const empty = runLua({ endpoint: 'listEvaluations', params: {}, queryResults: [[]], assertions: `
assert(type(result.evaluations) == 'table' and #result.evaluations == 0 and result.cursor == nil)
assert(calls[1].values[1] == '${EVALUATION}' and calls[1].values[2] == 26)
assert(calls[1].sql:find('ORDER BY sorted.sort_at DESC, evaluation.uri DESC', 1, true))
assert(#calls == 1, 'an empty page does not hydrate actors')
` });
  assert.equal(empty.status, 0, `${empty.stderr}${empty.stdout}`);

  const queryFailure = runLua({
    endpoint: 'listEvaluations', params: {}, queryResults: [], queryFailureAt: 1,
    expectError: 'EvaluationQueryFailed:',
  });
  assert.equal(queryFailure.status, 0, `${queryFailure.stderr}${queryFailure.stdout}`);

  const hydrationFailure = runLua({
    endpoint: 'listEvaluations', params: {}, queryResults: [[evaluationRow]], queryFailureAt: 2,
    expectError: 'EvaluationQueryFailed:',
  });
  assert.equal(hydrationFailure.status, 0, `${hydrationFailure.stderr}${hydrationFailure.stdout}`);
});
