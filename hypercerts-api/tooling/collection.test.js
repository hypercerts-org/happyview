import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const COLLECTION = 'org.hypercerts.collection';
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const collectionUri = `at://${did}/${COLLECTION}/collection-one`;
const itemUris = [
  'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/org.hypercerts.claim.activity/activity-one',
  'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/org.hypercerts.entity.feature/feature-one',
];
const tagUris = [
  'at://did:plc:cccccccccccccccccccccccccccccccc/org.hypercerts.vocab.tag/ecology.mangrove',
  'at://did:plc:dddddddddddddddddddddddddddddddd/org.hypercerts.vocab.tag/ecology.restoration',
];

function lua(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{ ${value.map(lua).join(', ')} }`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}] = ${lua(item)}`).join(', ')} }`;
  }
  throw new TypeError(`Cannot encode ${typeof value} as a Lua fixture`);
}

function runCollectionList() {
  const source = `
local NULL = {}
local collectionUri = ${JSON.stringify(collectionUri)}
local items = {
  { itemIdentifier = { uri = ${JSON.stringify(itemUris[1])}, cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
}
local tags = {
  { uri = ${JSON.stringify(tagUris[0])}, cid = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  { uri = ${JSON.stringify(tagUris[1])}, cid = 'bafyreicccccccccccccccccccccccccccccccccccccccccccccccccc' },
}
local collectionRecord = {
  ['$type'] = '${COLLECTION}', title = 'Matching collection', createdAt = '2025-01-01T00:00:00Z',
  items = items, tags = tags,
}
local row = {
  uri = collectionUri, did = '${did}', cid = 'bafyreidddddddddddddddddddddddddddddddddddddddddddddddddd',
  indexed_at = '2025-01-02T03:04:05.000Z', record = 'collection-record',
}
local calls = {}
json = {
  decode = function(value)
    if value == 'null' then return NULL end
    if value == 'collection-record' then return collectionRecord end
    error('unexpected JSON input: ' .. value)
  end,
}
toarray = function(values) return values end
params = {
  itemUris = { ${itemUris.map((uri) => JSON.stringify(uri)).join(', ')} },
  tagUris = { ${tagUris.map((uri) => JSON.stringify(uri)).join(', ')} },
}
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] ~= '${COLLECTION}' then return {} end

    for _, value in ipairs({ ${[...itemUris, ...tagUris].map((uri) => JSON.stringify(uri)).join(', ')} }) do
      local bound, placeholder = false, false
      for index, candidate in ipairs(values) do
        if candidate == value then
          assert(not bound, 'duplicate filter values must be removed before querying')
          bound = true
          placeholder = sql:find('$' .. index, 1, true) ~= nil
        end
      end
      assert(bound and placeholder, 'each reverse-item and tag filter value must be bound and used')
      assert(not sql:find(value, 1, true), 'filter values must not be interpolated into SQL')
    end
    return { row }
  end,
}
dofile('lua/endpoints/listCollections.lua')
local result = handle()
assert(#result.collections == 1 and result.collections[1].uri == collectionUri)
assert(result.collections[1].record.title == 'Matching collection')
assert(#result.collections[1].tags == 2, 'matching collection keeps both tag projections')
assert(result.collections[1].tags[1].uri == ${JSON.stringify(tagUris[0])})
assert(result.collections[1].tags[2].uri == ${JSON.stringify(tagUris[1])})
`;
  return spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
}

test('listCollections binds reverse-item and conjunctive-tag filter values and returns the matching collection', () => {
  const result = runCollectionList();
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listCollections hydrates distinct location versions when a page repeats an earlier reference', () => {
  const locationCollection = 'app.certified.location';
  const collectionRows = [
    { uri: `at://${did}/${COLLECTION}/first`, did, collection: COLLECTION, cid: 'collection-cid-1', indexed_at: '2025-01-02T00:00:00Z', record: 'first-record' },
    { uri: `at://${did}/${COLLECTION}/second`, did, collection: COLLECTION, cid: 'collection-cid-2', indexed_at: '2025-01-02T00:00:00Z', record: 'second-record' },
    { uri: `at://${did}/${COLLECTION}/third`, did, collection: COLLECTION, cid: 'collection-cid-3', indexed_at: '2025-01-02T00:00:00Z', record: 'third-record' },
  ];
  const locationA = { uri: `at://${did}/${locationCollection}/location-a`, cid: 'location-cid-a' };
  const locationB = { uri: `at://${did}/${locationCollection}/location-b`, cid: 'location-cid-b' };
  const records = {
    'first-record': { $type: COLLECTION, title: 'First', createdAt: '2025-01-01T00:00:00Z', location: locationA },
    'second-record': { $type: COLLECTION, title: 'Second', createdAt: '2025-01-02T00:00:00Z', location: locationB },
    'third-record': { $type: COLLECTION, title: 'Third', createdAt: '2025-01-03T00:00:00Z', location: locationA },
    'location-a-record': { $type: locationCollection, name: 'Location A', createdAt: '2025-01-01T00:00:00Z' },
    'location-b-record': { $type: locationCollection, name: 'Location B', createdAt: '2025-01-01T00:00:00Z' },
  };
  const locations = [
    { uri: locationA.uri, did, collection: locationCollection, cid: locationA.cid, indexed_at: '2025-01-02T00:00:00Z', record: 'location-a-record' },
    { uri: locationB.uri, did, collection: locationCollection, cid: locationB.cid, indexed_at: '2025-01-02T00:00:00Z', record: 'location-b-record' },
  ];
  const source = `
local NULL = {}
local ROWS = ${lua(collectionRows)}
local LOCATIONS = ${lua(locations)}
local RECORDS = ${lua(records)}
json = { decode = function(value)
  if value == 'null' then return NULL end
  return RECORDS[value]
end }
toarray = function(values) return values end
params = {}
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    if values[1] == '${COLLECTION}' then return ROWS end
    if values[1] == 'app.certified.actor.profile' or values[1] == 'app.certified.actor.organization' then return {} end
    if values[1] == '${locationCollection}' then
      local matched = {}
      for _, row in ipairs(LOCATIONS) do
        for index = 2, #values, 2 do
          if row.uri == values[index] and row.cid == values[index + 1] then
            matched[#matched + 1] = row
            break
          end
        end
      end
      return matched
    end
    return {}
  end,
}
dofile('lua/endpoints/listCollections.lua')
local result = handle()
assert(#result.collections == 3)
assert(result.collections[1].location.record.record.name == 'Location A')
assert(result.collections[2].location.record.record.name == 'Location B')
assert(result.collections[3].location.record.record.name == 'Location A')
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('getCollection emits JSON null for missing indexedAt on the collection and exact projections', () => {
  const locationCollection = 'app.certified.location';
  const locationUri = `at://${did}/${locationCollection}/nullable-location`;
  const tagUri = `at://${did}/org.hypercerts.vocab.tag/nullable-tag`;
  const collectionRecord = {
    $type: COLLECTION,
    title: 'Nullable index times',
    createdAt: '2025-01-01T00:00:00Z',
    location: { uri: locationUri, cid: 'location-cid' },
    tags: [{ uri: tagUri, cid: 'tag-cid' }],
  };
  const rows = [
    { uri: collectionUri, did, collection: COLLECTION, cid: 'collection-cid', record: 'collection-record' },
    { uri: locationUri, did, collection: locationCollection, cid: 'location-cid', record: 'location-record' },
    { uri: tagUri, did, collection: 'org.hypercerts.vocab.tag', cid: 'tag-cid', record: 'tag-record' },
    { uri: `at://${did}/app.certified.actor.profile/self`, did, collection: 'app.certified.actor.profile', cid: 'profile-cid', record: 'profile-record' },
  ];
  const records = {
    'collection-record': collectionRecord,
    'location-record': { $type: locationCollection, name: 'Nullable location', createdAt: '2025-01-01T00:00:00Z' },
    'tag-record': { $type: 'org.hypercerts.vocab.tag', name: 'Nullable tag', createdAt: '2025-01-01T00:00:00Z' },
    'profile-record': { $type: 'app.certified.actor.profile', displayName: 'Collection author', createdAt: '2025-01-01T00:00:00Z' },
  };
  const source = `
local NULL = {}
local ROWS = ${lua(rows)}
local RECORDS = ${lua(records)}
json = { decode = function(value)
  if value == 'null' then return NULL end
  return RECORDS[value]
end }
toarray = function(values) return values end
params = { uri = ${JSON.stringify(collectionUri)} }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    local target = values[1]
    if target == '${COLLECTION}' then return { ROWS[1] } end
    if target == '${locationCollection}' then return { ROWS[2] } end
    if target == 'org.hypercerts.vocab.tag' then return { ROWS[3] } end
    if target == 'app.certified.actor.profile' then return { ROWS[4] } end
    return {}
  end,
}
dofile('lua/endpoints/getCollection.lua')
local view = handle().collection
assert(view.indexedAt == NULL, 'collection indexedAt must serialize SQL NULL explicitly')
assert(view.author.profile.indexedAt == NULL, 'collection author indexedAt must serialize SQL NULL explicitly')
assert(view.location.record.indexedAt == NULL, 'exact location indexedAt must serialize SQL NULL explicitly')
assert(view.tags[1].record.indexedAt == NULL, 'exact tag indexedAt must serialize SQL NULL explicitly')
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('getCollection looks up the exact URI and preserves ordered unresolved projections', () => {
  const locationUri = `at://${did}/app.certified.location/location-one`;
  const tagUrisWithDuplicate = [tagUris[1], tagUris[0], tagUris[1]];
  const collectionRecord = {
    $type: COLLECTION,
    title: 'Exact collection',
    createdAt: '2025-01-01T00:00:00Z',
    location: { uri: locationUri, cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    tags: tagUrisWithDuplicate.map((uri, index) => ({
      uri,
      cid: `bafy${String.fromCharCode(98 + index)}${'b'.repeat(50)}`,
    })),
  };
  const source = `
local NULL = {}
local collectionUri = ${JSON.stringify(collectionUri)}
local record = ${lua(collectionRecord)}
local row = {
  uri = collectionUri, did = '${did}', cid = 'bafyreidddddddddddddddddddddddddddddddddddddddddddddddddd',
  indexed_at = '2025-01-02T03:04:05.000Z', record = 'collection-record',
}
local calls = {}
json = { decode = function(value)
  if value == 'null' then return NULL end
  if value == 'collection-record' then return record end
  error('unexpected JSON input: ' .. value)
end }
toarray = function(values) return values end
params = { uri = collectionUri }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == '${COLLECTION}' then
      assert(values[2] == collectionUri, 'getCollection must bind the exact requested URI')
      assert(not sql:find(collectionUri, 1, true), 'the exact URI must not be interpolated into SQL')
      return { row }
    end
    return {}
  end,
}
dofile('lua/endpoints/getCollection.lua')
local result = handle()
local view = result.collection
assert(view.uri == collectionUri and view.record.title == 'Exact collection')
assert(view.author.did == '${did}' and view.author.profile == NULL and view.author.organization == NULL)
assert(view.location.uri == ${JSON.stringify(locationUri)} and view.location.record == NULL)
assert(#view.tags == 3, 'tag projection preserves duplicate references')
assert(view.tags[1].uri == ${JSON.stringify(tagUrisWithDuplicate[0])})
assert(view.tags[2].uri == ${JSON.stringify(tagUrisWithDuplicate[1])})
assert(view.tags[3].uri == ${JSON.stringify(tagUrisWithDuplicate[2])})
assert(view.record.tags[1].uri == view.tags[1].uri, 'hydration must not rewrite the source record')
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('get/list/search preserve wrong-collection location and tag references as unresolved projections', () => {
  const locationCollection = 'app.certified.location';
  const tagCollection = 'org.hypercerts.vocab.tag';
  const wrongLocationUri = `at://${did}/${tagCollection}/not-a-location`;
  const wrongTagUri = `at://${did}/${locationCollection}/not-a-tag`;
  const locationUri = `at://${did}/${locationCollection}/resolved-location`;
  const tagUri = `at://${did}/${tagCollection}/resolved-tag`;
  const wrongLocation = { uri: wrongLocationUri, cid: 'wrong-location-cid' };
  const wrongTag = { uri: wrongTagUri, cid: 'wrong-tag-cid' };
  const location = { uri: locationUri, cid: 'location-cid' };
  const tag = { uri: tagUri, cid: 'tag-cid' };
  const collectionRows = [
    { uri: collectionUri, did, cid: 'collection-cid-bad', indexed_at: '2025-01-02T00:00:00Z', record: 'wrong-record' },
    { uri: `at://${did}/${COLLECTION}/other`, did, cid: 'collection-cid-good', indexed_at: '2025-01-01T00:00:00Z', record: 'other-record' },
  ];
  const relatedRows = [
    { uri: location.uri, did, collection: locationCollection, cid: location.cid, indexed_at: '2025-01-02T00:00:00Z', record: 'location-record' },
    { uri: tag.uri, did, collection: tagCollection, cid: tag.cid, indexed_at: '2025-01-02T00:00:00Z', record: 'tag-record' },
  ];
  const records = {
    'wrong-record': { $type: COLLECTION, title: 'Wrong collection refs', createdAt: '2025-01-01T00:00:00Z', location: wrongLocation, tags: [wrongTag, tag] },
    'other-record': { $type: COLLECTION, title: 'Other collection', createdAt: '2025-01-01T00:00:00Z', location, tags: [tag] },
    'location-record': { $type: locationCollection, name: 'Resolved location', createdAt: '2025-01-01T00:00:00Z' },
    'tag-record': { $type: tagCollection, name: 'Resolved tag', createdAt: '2025-01-01T00:00:00Z' },
  };

  for (const endpoint of ['getCollection', 'listCollections', 'searchCollections']) {
    const badView = endpoint === 'getCollection' ? 'result.collection' : 'result.collections[1]';
    const goodViewAssertions = endpoint === 'getCollection' ? '' : `
local good = result.collections[2]
assert(good.location.record.record.name == 'Resolved location')
assert(good.tags[1].record.record.name == 'Resolved tag')
`;
    const source = `
local NULL = {}
local ROWS = ${lua(collectionRows)}
local RELATED = ${lua(relatedRows)}
local RECORDS = ${lua(records)}
json = { decode = function(value)
  if value == 'null' then return NULL end
  return RECORDS[value]
end }
toarray = function(values) return values end
params = ${endpoint === 'getCollection'
    ? `{ uri = ${JSON.stringify(collectionRows[0].uri)} }`
    : endpoint === 'searchCollections' ? "{ search = 'collection' }" : '{}'}
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    local target = values[1]
    if target == '${COLLECTION}' then
      if '${endpoint}' == 'getCollection' then return { ROWS[1] } end
      return ROWS
    end
    if target == 'app.certified.actor.profile' or target == 'app.certified.actor.organization' then return {} end
    local matched = {}
    for _, row in ipairs(RELATED) do
      if row.collection == target then
        for index = 2, #values, 2 do
          if row.uri == values[index] and row.cid == values[index + 1] then
            matched[#matched + 1] = row
            break
          end
        end
      end
    end
    return matched
  end,
}
dofile('lua/endpoints/${endpoint}.lua')
local result = handle()
local bad = ${badView}
assert(bad.location.uri == ${JSON.stringify(wrongLocation.uri)} and bad.location.cid == 'wrong-location-cid')
assert(bad.location.record == NULL, 'wrong-collection location reference must project JSON null')
assert(bad.tags[1].uri == ${JSON.stringify(wrongTag.uri)} and bad.tags[1].cid == 'wrong-tag-cid')
assert(bad.tags[1].record == NULL, 'wrong-collection tag reference must project JSON null')
assert(bad.record.location.uri == ${JSON.stringify(wrongLocation.uri)} and bad.record.location.cid == 'wrong-location-cid')
assert(bad.record.tags[1].uri == ${JSON.stringify(wrongTag.uri)} and bad.record.tags[1].cid == 'wrong-tag-cid')
${goodViewAssertions}
`;
    const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${endpoint}: ${result.stderr}${result.stdout}`);
  }
});

test('collection hydration still rejects missing, non-string, and malformed reference fields', () => {
  const locationCollection = 'app.certified.location';
  const validLocationUri = `at://${did}/${locationCollection}/location-one`;
  const invalidReferences = [
    { name: 'missing URI', value: { cid: 'location-cid' } },
    { name: 'non-string URI', value: { uri: 7, cid: 'location-cid' } },
    { name: 'missing CID', value: { uri: validLocationUri } },
    { name: 'non-string CID', value: { uri: validLocationUri, cid: 7 } },
    { name: 'malformed URI', value: { uri: 'not-an-at-uri', cid: 'location-cid' } },
  ];

  for (const scenario of invalidReferences) {
    const source = `
local NULL = {}
local record = { ["$type"] = '${COLLECTION}', title = 'Invalid reference', createdAt = '2025-01-01T00:00:00Z', location = ${lua(scenario.value)} }
json = { decode = function(value)
  if value == 'null' then return NULL end
  if value == 'collection-record' then return record end
end }
toarray = function(values) return values end
params = { uri = ${JSON.stringify(collectionUri)} }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    if values[1] == '${COLLECTION}' then
      return { { uri = ${JSON.stringify(collectionUri)}, did = '${did}', cid = 'collection-cid', record = 'collection-record' } }
    end
    return {}
  end,
}
dofile('lua/endpoints/getCollection.lua')
local ok, message = pcall(handle)
assert(not ok and tostring(message):find('CollectionQueryFailed: indexed collection has an invalid location reference', 1, true), '${scenario.name} must remain a query error')
`;
    const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}${result.stdout}`);
  }
});

test('searchCollections binds complete trimmed search text literally', () => {
  const searchInput = '  Forest %_ Initiative  ';
  const search = 'Forest %_ Initiative';
  const record = {
    $type: COLLECTION,
    title: 'Forest %_ Initiative',
    createdAt: '2025-01-01T00:00:00Z',
  };
  const source = `
local NULL = {}
local collectionRecord = ${lua(record)}
local row = {
  uri = ${JSON.stringify(collectionUri)}, did = '${did}', cid = 'bafyreidddddddddddddddddddddddddddddddddddddddddddddddddd',
  indexed_at = '2025-01-02T03:04:05.000Z', record = 'collection-record',
}
local calls = {}
json = { decode = function(value)
  if value == 'null' then return NULL end
  if value == 'collection-record' then return collectionRecord end
  error('unexpected JSON input: ' .. value)
end }
toarray = function(values) return values end
params = { search = ${JSON.stringify(searchInput)}, authors = { '${did}' } }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == '${COLLECTION}' then
      local hasSearch, hasAuthor = false, false
      for index, value in ipairs(values) do
        if value == ${JSON.stringify(search)} then
          hasSearch = true
          assert(sql:find('$' .. index, 1, true), 'trimmed search must be used as a bound value')
        end
        if value == '${did}' then hasAuthor = true end
      end
      assert(hasSearch and hasAuthor, 'search and author filters must both be bound')
      assert(not sql:find(${JSON.stringify(search)}, 1, true), 'search text must not be interpolated into SQL')
      return { row }
    end
    return {}
  end,
}
dofile('lua/endpoints/searchCollections.lua')
local result = handle()
assert(#result.collections == 1 and result.collections[1].record.title == 'Forest %_ Initiative')
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('collection listing filters solely by organization self-record presence', () => {
  const scenarios = [
    { endpoint: 'listCollections', flag: 'true', predicate: 'EXISTS', did: 'did:web:organization-only.example', hasOrganization: true },
    { endpoint: 'searchCollections', flag: 'false', predicate: 'NOT EXISTS', did: 'did:web:no-relations.example', hasOrganization: false, search: 'forest' },
    { endpoint: 'listCollections', flag: true, predicate: 'EXISTS', did: 'did:web:coerced-organization.example', hasOrganization: true },
    { endpoint: 'searchCollections', flag: false, predicate: 'NOT EXISTS', did: 'did:web:coerced-no-relations.example', hasOrganization: false, search: 'forest' },
  ];
  for (const scenario of scenarios) {
    const uri = `at://${scenario.did}/${COLLECTION}/organization-filter`;
    const collectionRecord = { $type: COLLECTION, title: 'Organization filter', createdAt: '2025-01-01T00:00:00Z' };
    const organizationRecord = {
      $type: 'app.certified.actor.organization', organizationType: ['community'], createdAt: '2025-01-01T00:00:00Z',
    };
    const organizationRows = scenario.hasOrganization ? [{
      uri: `at://${scenario.did}/app.certified.actor.organization/self`, did: scenario.did,
      collection: 'app.certified.actor.organization', cid: 'organization-cid', indexed_at: '2025-01-02T03:04:05.000Z',
      record: 'organization-record',
    }] : [];
    const source = `
local NULL = {}
local collectionRecord = ${lua(collectionRecord)}
local organizationRecord = ${lua(organizationRecord)}
local row = {
  uri = ${JSON.stringify(uri)}, did = ${JSON.stringify(scenario.did)}, collection = '${COLLECTION}',
  cid = 'collection-cid', indexed_at = '2025-01-02T03:04:05.000Z', record = 'collection-record',
}
local organizationRows = ${lua(organizationRows)}
local calls = {}
json = { decode = function(value)
  if value == 'null' then return NULL end
  if value == 'collection-record' then return collectionRecord end
  if value == 'organization-record' then return organizationRecord end
  error('unexpected JSON input: ' .. value)
end }
toarray = function(values) return values end
params = { authors = { ${JSON.stringify(scenario.did)} }, hasOrganizationRecord = ${lua(scenario.flag)}${scenario.search ? `, search = '${scenario.search}'` : ''} }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    if values[1] == '${COLLECTION}' then
      local query = calls[1].sql
      assert(query:find("${scenario.predicate} (SELECT 1 FROM happyview_records AS organization", 1, true))
      assert(query:find("organization.collection = 'app.certified.actor.organization'", 1, true))
      assert(query:find("organization.rkey = 'self'", 1, true) and query:find('organization.did = collection.did', 1, true))
      assert(not query:find("app.certified.actor.profile", 1, true), 'the filter must not depend on profiles')
      return { row }
    end
    if values[1] == 'app.certified.actor.organization' then return organizationRows end
    return {}
  end,
}
dofile('lua/endpoints/${scenario.endpoint}.lua')
local result = handle()
assert(#result.collections == 1 and result.collections[1].uri == ${JSON.stringify(uri)})
assert(result.collections[1].author.profile == NULL)
${scenario.hasOrganization ? `assert(result.collections[1].author.organization.did == ${JSON.stringify(scenario.did)})` : `assert(result.collections[1].author.organization == NULL)`}
params = { authorType = 'person'${scenario.search ? `, search = '${scenario.search}'` : ''} }
local ok, message = pcall(handle)
assert(not ok and tostring(message):find('InvalidRequest: unknown query parameter:', 1, true))
assert(#calls == 3, 'removed authorType must be rejected before querying')
params = { hasOrganizationRecord = 'sometimes'${scenario.search ? `, search = '${scenario.search}'` : ''} }
ok, message = pcall(handle)
assert(not ok and tostring(message):find('InvalidRequest:', 1, true))
assert(#calls == 3, 'invalid organization-record flags must be rejected before querying')
params = { hasOrganizationRecord = { 'true', 'false' }${scenario.search ? `, search = '${scenario.search}'` : ''} }
ok, message = pcall(handle)
assert(not ok and tostring(message):find('InvalidRequest: hasOrganizationRecord must occur once', 1, true))
assert(#calls == 3, 'repeated organization-record flags must be rejected before querying')
`;
    const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  }
});

test('collection Lexicons and module manifest close all four endpoint contracts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const collectionModulePath = 'modules/collection/manifest.json';
  assert.ok(manifest.modules.includes(collectionModulePath), 'root bundle includes the collection module');

  const endpointIds = [
    'org.hypercerts.collection.getCollection',
    'org.hypercerts.collection.listCollections',
    'org.hypercerts.collection.searchCollections',
    'org.hypercerts.collection.listCollectionItems',
  ];
  const validationIds = new Set(manifest.validationLexicons.map(({ id }) => id));
  for (const id of [
    'org.hypercerts.collection',
    'org.hypercerts.entity.feature',
    'org.hypercerts.vocab.tag',
    ...endpointIds,
  ]) assert.ok(validationIds.has(id), `validation closure includes ${id}`);

  const module = JSON.parse(await readFile(new URL(`../${collectionModulePath}`, import.meta.url), 'utf8'));
  const assets = new Map(module.assets.map((asset) => [asset.id, asset]));
  for (const id of endpointIds) {
    const query = JSON.parse(await readFile(new URL(`../lexicons/${id}.json`, import.meta.url), 'utf8'));
    assert.equal(query.id, id);
    assert.ok(assets.has(id), `collection module installs Lexicon ${id}`);
    assert.ok(assets.has(`xrpc.query:${id}`), `collection module installs handler ${id}`);
  }

  const get = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.collection.getCollection.json', import.meta.url), 'utf8'));
  const list = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.collection.listCollections.json', import.meta.url), 'utf8'));
  const search = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.collection.searchCollections.json', import.meta.url), 'utf8'));
  const items = JSON.parse(await readFile(new URL('../lexicons/org.hypercerts.collection.listCollectionItems.json', import.meta.url), 'utf8'));
  const collectionView = get.defs.collectionView;
  assert.deepEqual(collectionView.required, ['uri', 'cid', 'indexedAt', 'did', 'author', 'record']);
  assert.deepEqual(collectionView.nullable, ['indexedAt']);
  assert.deepEqual(get.defs.locationRecordView.nullable, ['indexedAt']);
  assert.deepEqual(get.defs.vocabTagRecordView.nullable, ['indexedAt']);
  assert.deepEqual(get.defs.collectionProfileView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.deepEqual(get.defs.collectionProfileView.nullable, ['indexedAt']);
  assert.deepEqual(get.defs.collectionOrganizationView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.deepEqual(get.defs.collectionOrganizationView.nullable, ['indexedAt']);
  assert.deepEqual(get.defs.collectionActorView.nullable, ['profile', 'organization']);
  assert.equal(collectionView.properties.author.ref, '#collectionActorView');
  assert.equal(collectionView.properties.record.ref, COLLECTION);
  assert.equal(collectionView.required.includes('location'), false);
  assert.equal(collectionView.required.includes('tags'), false);
  assert.deepEqual(get.defs.collectionLocationView.nullable, ['record']);
  assert.deepEqual(get.defs.collectionTagView.nullable, ['record']);

  const expectedFilters = ['authors', 'hasOrganizationRecord', 'cursor', 'itemUris', 'limit', 'sortDirection', 'tagUris', 'types', 'uris'].sort();
  assert.deepEqual(Object.keys(list.defs.main.parameters.properties).sort(), expectedFilters);
  assert.deepEqual(Object.keys(search.defs.main.parameters.properties).sort(), [...expectedFilters, 'search'].sort());
  assert.deepEqual(search.defs.main.parameters.required, ['search']);
  for (const query of [list, search]) {
    const properties = query.defs.main.parameters.properties;
    for (const name of ['authors', 'types', 'uris', 'itemUris', 'tagUris']) assert.equal(properties[name].maxLength, 100);
    assert.equal(properties.hasOrganizationRecord.type, 'boolean');
    assert.match(properties.hasOrganizationRecord.description, /organization\/self/i);
    assert.match(properties.hasOrganizationRecord.description, /regardless of profile/i);
    assert.equal(Object.hasOwn(properties, 'authorType'), false);
    assert.equal(properties.limit.maximum, 100);
    assert.equal(query.defs.output.properties.collections.items.ref, `${get.id}#collectionView`);
  }

  const itemParameters = items.defs.main.parameters.properties;
  assert.deepEqual(Object.keys(itemParameters).sort(), ['collection', 'cursor', 'limit']);
  assert.deepEqual(items.defs.main.parameters.required, ['collection']);
  assert.equal(itemParameters.limit.maximum, 100);
  assert.deepEqual(items.defs.featureView.nullable, ['indexedAt']);
  assert.equal(items.defs.featureView.properties.author.ref, `${get.id}#collectionActorView`);
  assert.deepEqual(items.defs.collectionItemView.required, ['itemIdentifier', 'record']);
  assert.deepEqual(items.defs.collectionItemView.nullable, ['record']);
  assert.deepEqual(items.defs.collectionItemView.properties.record.refs, [
    'org.hypercerts.claim.getActivity#activityView',
    '#collectionSummaryView',
    '#featureView',
  ]);
});

test('listCollectionItems skips a URI-only source item and advances the cursor to the next valid item', () => {
  const firstCid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const lastCid = 'bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const first = { itemIdentifier: { uri: itemUris[0], cid: firstCid }, itemWeight: '1' };
  const broken = { itemIdentifier: { uri: itemUris[1] } };
  const last = { itemIdentifier: { uri: itemUris[1], cid: lastCid }, itemWeight: '3' };
  const source = `
local NULL = {}
local record = { items = ${lua([first, broken, last])} }
json = {
  decode = function(value)
    if value == 'null' then return NULL end
    if value == 'collection-record' then return record end
    return { v = tonumber(value:match('"v":(%d+)')), u = value:match('"u":"([^"]+)"'), i = tonumber(value:match('"i":(%d+)')) }
  end,
  encode = function(value) return string.format('{"v":%d,"u":"%s","i":%d}', value.v, value.u, value.i) end,
}
toarray = function(value) return value end
params = { collection = ${JSON.stringify(collectionUri)}, limit = '1' }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    if values[1] == '${COLLECTION}' and values[2] == ${JSON.stringify(collectionUri)} then
      return { { uri = ${JSON.stringify(collectionUri)}, record = 'collection-record' } }
    end
    return {}
  end,
}
dofile('lua/endpoints/listCollectionItems.lua')
local first_page = handle()
assert(#first_page.items == 1 and first_page.items[1].itemWeight == '1')
assert(first_page.cursor ~= nil)
params.cursor = first_page.cursor
local second_page = handle()
assert(#second_page.items == 1 and second_page.items[1].itemWeight == '3')
assert(second_page.items[1].itemIdentifier.cid == ${JSON.stringify(lastCid)})
assert(second_page.items[1].record == NULL and second_page.cursor == nil)
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('listCollectionItems preserves source order and weights and resolves only exact supported versions', () => {
  const itemCollectionUri = `at://${did}/${COLLECTION}/parent`;
  const activityUri = `at://${did}/org.hypercerts.claim.activity/activity-one`;
  const featureDid = 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee';
  const featureUri = `at://${featureDid}/org.hypercerts.entity.feature/feature-one`;
  const nestedUri = `at://${did}/${COLLECTION}/nested`;
  const activityCid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const featureCid = 'bafyreibbccccccccccccccccccccccccccccccccccccccccccccccccc';
  const nestedCid = 'bafyreicddddddddddddddddddddddddddddddddddddddddddddddddd';
  const unavailableCid = 'bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const parentRecord = {
    $type: COLLECTION,
    title: 'Parent collection',
    createdAt: '2025-01-01T00:00:00Z',
    items: [
      { itemIdentifier: { uri: activityUri, cid: activityCid }, itemWeight: '0.5' },
      { itemIdentifier: { uri: nestedUri, cid: nestedCid } },
      { itemIdentifier: { uri: featureUri, cid: featureCid }, itemWeight: '1.25' },
      { itemIdentifier: { uri: activityUri, cid: unavailableCid }, itemWeight: '2' },
    ],
  };
  const records = {
    'parent-record': parentRecord,
    'activity-record': {
      $type: 'org.hypercerts.claim.activity', title: 'Resolved activity', createdAt: '2025-01-01T00:00:00Z',
    },
    'feature-record': {
      $type: 'org.hypercerts.entity.feature', type: 'zone', title: 'Resolved feature', createdAt: '2025-01-01T00:00:00Z',
    },
    'feature-author-profile': {
      $type: 'app.certified.actor.profile', displayName: 'Feature author', createdAt: '2025-01-01T00:00:00Z',
    },
    'nested-record': {
      $type: COLLECTION, type: 'project', title: 'Nested summary', shortDescription: 'One level only', createdAt: '2025-01-01T00:00:00Z',
    },
  };
  const rows = [
    {
      uri: itemCollectionUri, did, collection: COLLECTION, cid: 'bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff',
      indexed_at: '2025-01-02T03:04:05.000Z', record: 'parent-record',
    },
    {
      uri: activityUri, did, collection: 'org.hypercerts.claim.activity', cid: activityCid,
      indexed_at: '2025-01-02T03:04:05.000Z', record: 'activity-record',
    },
    {
      uri: featureUri, did: featureDid, collection: 'org.hypercerts.entity.feature', cid: featureCid,
      record: 'feature-record',
    },
    {
      uri: `at://${featureDid}/app.certified.actor.profile/self`, did: featureDid,
      collection: 'app.certified.actor.profile', cid: 'bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff',
      record: 'feature-author-profile',
    },
    {
      uri: nestedUri, did, collection: COLLECTION, cid: nestedCid,
      indexed_at: '2025-01-02T03:04:05.000Z', record: 'nested-record',
    },
  ];
  const source = `
local NULL = {}
local ROWS = ${lua(rows)}
local RECORDS = ${lua(records)}
json = {
  decode = function(value)
    if value == 'null' then return NULL end
    return RECORDS[value]
  end,
}
toarray = function(values) return values end
params = { collection = ${JSON.stringify(itemCollectionUri)} }
db = {
  backend = function() return 'postgres' end,
  raw = function(sql, values)
    local targetCollection = values[1]
    if targetCollection == '${COLLECTION}' and values[2] == ${JSON.stringify(itemCollectionUri)} then
      return { ROWS[1] }
    end
    if targetCollection == 'app.certified.actor.profile' then
      for _, row in ipairs(ROWS) do
        if row.collection == targetCollection and row.did == values[2] then return { row } end
      end
      return {}
    end
    if targetCollection == 'org.hypercerts.claim.activity' or targetCollection == 'org.hypercerts.entity.feature' or targetCollection == '${COLLECTION}' then
      local matches = {}
      for _, row in ipairs(ROWS) do
        if row.collection == targetCollection then
          for index = 2, #values, 2 do
            if row.uri == values[index] and row.cid == values[index + 1] then
              matches[#matches + 1] = row
              break
            end
          end
        end
      end
      return matches
    end
    return {}
  end,
}
dofile('lua/endpoints/listCollectionItems.lua')
local result = handle()
assert(#result.items == 4)
assert(result.items[1].itemIdentifier.uri == ${JSON.stringify(activityUri)} and result.items[1].itemWeight == '0.5')
assert(result.items[1].record.uri == ${JSON.stringify(activityUri)})
assert(result.items[1].record['$type'] == 'org.hypercerts.claim.getActivity#activityView')
assert(result.items[1].record.record.title == 'Resolved activity')
assert(result.items[2].record['$type'] == 'org.hypercerts.collection.listCollectionItems#collectionSummaryView')
assert(result.items[2].record.title == 'Nested summary' and result.items[2].record.shortDescription == 'One level only')
assert(result.items[3].itemWeight == '1.25')
assert(result.items[3].record['$type'] == 'org.hypercerts.collection.listCollectionItems#featureView')
assert(result.items[3].record.record.title == 'Resolved feature')
assert(result.items[3].record.indexedAt == NULL, 'exact feature indexedAt must serialize SQL NULL explicitly')
assert(result.items[3].record.author.profile.indexedAt == NULL, 'feature author indexedAt must serialize SQL NULL explicitly')
assert(result.items[4].itemIdentifier.cid == '${unavailableCid}' and result.items[4].record == NULL)
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});
