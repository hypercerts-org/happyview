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

test('getCollection preserves wrong-collection references as unresolved projections', () => {
  const location = { uri: `at://${did}/org.hypercerts.vocab.tag/not-a-location`, cid: 'location-cid' };
  const tag = { uri: `at://${did}/app.certified.location/not-a-tag`, cid: 'tag-cid' };
  const record = { $type: COLLECTION, title: 'Crossed references', createdAt: '2025-01-01T00:00:00Z', location, tags: [tag] };
  const source = `
local NULL = {}
local RECORD = ${lua(record)}
json = { decode = function(value)
  if value == 'null' then return NULL end
  if value == 'collection-record' then return RECORD end
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
local view = handle().collection
assert(view.location.uri == ${JSON.stringify(location.uri)} and view.location.cid == 'location-cid')
assert(view.location.record == NULL, 'wrong-collection location must remain unresolved')
assert(view.tags[1].uri == ${JSON.stringify(tag.uri)} and view.tags[1].cid == 'tag-cid')
assert(view.tags[1].record == NULL, 'wrong-collection tag must remain unresolved')
assert(view.record.location.uri == view.location.uri and view.record.tags[1].uri == view.tags[1].uri)
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
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

  const expectedFilters = ['authors', 'authorType', 'cursor', 'itemUris', 'limit', 'sortDirection', 'tagUris', 'types', 'uris'].sort();
  assert.deepEqual(Object.keys(list.defs.main.parameters.properties).sort(), expectedFilters);
  assert.deepEqual(Object.keys(search.defs.main.parameters.properties).sort(), [...expectedFilters, 'search'].sort());
  assert.deepEqual(search.defs.main.parameters.required, ['search']);
  for (const query of [list, search]) {
    const properties = query.defs.main.parameters.properties;
    for (const name of ['authors', 'types', 'uris', 'itemUris', 'tagUris']) assert.equal(properties[name].maxLength, 100);
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

test('listCollectionItems names unknown query parameters in InvalidRequest diagnostics', () => {
  const source = `
local NULL = {}
json = { decode = function(value) if value == 'null' then return NULL end return {} end }
toarray = function(values) return values end
params = { collection = ${JSON.stringify(collectionUri)}, bogus = '1' }
local calls = 0
db = {
  backend = function() return 'postgres' end,
  raw = function() calls = calls + 1; return {} end,
}
dofile('lua/endpoints/listCollectionItems.lua')
local ok, result = pcall(handle)
assert(not ok)
assert(tostring(result) == 'InvalidRequest: unknown query parameter: bogus', tostring(result))
assert(calls == 0, 'unknown parameters must be rejected before database access')
`;
  const result = spawnSync('lua5.4', ['-e', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});
