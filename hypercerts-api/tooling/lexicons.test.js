import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { locationRecords, profileRecords, organizationRecords } from '../tests/fixtures/records.js';
import { validatePackageLexicons } from './validate-lexicons.js';
import { readLexiconSource } from './lexicon-source.js';
import { loadAssets } from './installer.js';
import { fileURLToPath } from 'node:url';

test('the full validation Lexicon closure resolves locally while only selected package Lexicons deploy', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  const { documents } = await validatePackageLexicons();
  const validatedIds = documents.map((document) => document.id);
  assert.deepEqual(validatedIds.sort(), manifest.validationLexicons.map(({ id }) => id).sort());

  const validationSources = new Map(manifest.validationLexicons.map((source) => [source.id, source]));
  const deployedPackageAssets = assets.filter(({ kind, packagePath }) => kind === 'lexicon' && packagePath);
  assert.deepEqual(deployedPackageAssets.map(({ id }) => id).sort(), [
    'app.certified.actor.organization',
    'app.certified.actor.profile',
    'app.certified.graph.follow',
    'app.certified.location',
    'app.certified.signature.defs',
    'org.hypercerts.claim.activity',
    'org.hypercerts.claim.contributorInformation',
    'org.hypercerts.defs',
  ]);
  for (const asset of deployedPackageAssets) {
    const source = validationSources.get(asset.id);
    assert.equal(asset.packagePath, source.packagePath);
    const document = await readLexiconSource(source);
    assert.equal(document.id, asset.id);
    assert.deepEqual(asset.lexicon_json, document);
  }
});

test('location query result refs resolve to shared actor views and getLocation-owned locationView', async () => {
  const { lexicons, documents } = await validatePackageLexicons();
  const byId = new Map(documents.map((document) => [document.id, document]));
  const shared = byId.get('org.hypercerts.api.defs');
  const getLocation = byId.get('app.certified.location.getLocation');
  const listLocations = byId.get('app.certified.location.listLocations');
  assert.ok(shared, 'validation sources include the shared API definitions');
  assert.ok(getLocation, 'validation sources include getLocation');
  assert.ok(listLocations, 'validation sources include listLocations');
  assert.equal(Object.hasOwn(listLocations.defs.main.parameters.properties, 'search'), false, 'listLocations must not expose a search parameter');

  assert.equal(lexicons.getDefOrThrow('org.hypercerts.api.defs#profileView').type, 'object');
  assert.equal(lexicons.getDefOrThrow('org.hypercerts.api.defs#organizationView').type, 'object');
  assert.equal(lexicons.getDefOrThrow('org.hypercerts.api.defs#actorView').type, 'object');
  assert.deepEqual(shared.defs.profileView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.equal(shared.defs.profileView.properties.record.ref, 'lex:app.certified.actor.profile');
  assert.deepEqual(shared.defs.organizationView.required, ['uri', 'cid', 'indexedAt', 'did', 'record']);
  assert.equal(shared.defs.organizationView.properties.record.ref, 'lex:app.certified.actor.organization');
  assert.deepEqual(shared.defs.actorView.required, ['did', 'profile', 'organization']);
  assert.deepEqual(shared.defs.actorView.nullable, ['profile', 'organization']);
  assert.equal(shared.defs.actorView.properties.profile.ref, 'lex:org.hypercerts.api.defs#profileView');
  assert.equal(shared.defs.actorView.properties.organization.ref, 'lex:org.hypercerts.api.defs#organizationView');
  assert.equal(shared.defs.locationView, undefined);

  assert.equal(getLocation.defs.locationView.type, 'object');
  assert.equal(getLocation.defs.locationView.properties.author.ref, 'lex:org.hypercerts.api.defs#actorView');
  assert.equal(getLocation.defs.locationView.properties.record.ref, 'lex:app.certified.location');
  assert.equal(getLocation.defs.output.properties.location.ref, 'lex:app.certified.location.getLocation#locationView');
  assert.equal(listLocations.defs.output.properties.locations.items.ref, 'lex:app.certified.location.getLocation#locationView');
  assert.equal(lexicons.getDefOrThrow('app.certified.location.getLocation#locationView').type, 'object');
});

test('organization query Lexicons keep the shared defs unchanged and reuse the required nullable actor view', async () => {
  const { lexicons, documents } = await validatePackageLexicons();
  const byId = new Map(documents.map((document) => [document.id, document]));
  const shared = byId.get('org.hypercerts.api.defs');
  const getOrganization = byId.get('app.certified.actor.getOrganization');
  const listOrganizations = byId.get('app.certified.actor.listOrganizations');
  const searchOrganizations = byId.get('app.certified.actor.searchOrganizations');
  assert.ok(shared && getOrganization && listOrganizations && searchOrganizations);
  assert.equal(shared.defs.organizationActorView, undefined, 'avoid changing the installed shared defs Lexicon');

  const actorView = lexicons.getDefOrThrow('app.certified.actor.getOrganization#organizationActorView');
  assert.deepEqual(actorView.required, ['did', 'profile', 'organization']);
  assert.deepEqual(actorView.nullable, ['profile']);
  assert.equal(actorView.properties.profile.ref, 'lex:org.hypercerts.api.defs#profileView');
  assert.equal(actorView.properties.organization.ref, 'lex:org.hypercerts.api.defs#organizationView');
  assert.equal(getOrganization.defs.output.properties.actor.ref, 'lex:app.certified.actor.getOrganization#organizationActorView');
  assert.deepEqual(getOrganization.defs.main.errors.map(({ name }) => name), ['InvalidRequest', 'RecordNotFound']);

  const listParameters = listOrganizations.defs.main.parameters.properties;
  const searchParameters = searchOrganizations.defs.main.parameters.properties;
  assert.deepEqual(Object.keys(listParameters).sort(), ['actors', 'cursor', 'limit', 'organizationTypes', 'sortDirection', 'visibility']);
  assert.deepEqual(Object.keys(searchParameters).sort(), ['actors', 'cursor', 'limit', 'organizationTypes', 'search', 'sortDirection', 'visibility']);
  assert.deepEqual(searchOrganizations.defs.main.parameters.required, ['search']);
  for (const query of [listOrganizations, searchOrganizations]) {
    assert.equal(query.defs.main.parameters.properties.actors.maxLength, 100);
    assert.equal(query.defs.main.parameters.properties.organizationTypes.maxLength, 100);
    assert.equal(query.defs.output.properties.actors.items.ref, 'lex:app.certified.actor.getOrganization#organizationActorView');
  }
  assert.equal(lexicons.getDefOrThrow(listOrganizations.defs.output.properties.actors.items.ref).type, 'object');
  assert.equal(lexicons.getDefOrThrow(searchOrganizations.defs.output.properties.actors.items.ref).type, 'object');
});

test('follow query Lexicons declare all required DID parameters', async () => {
  const { documents } = await validatePackageLexicons();
  const byId = new Map(documents.map((document) => [document.id, document]));
  assert.deepEqual({
    getFollow: byId.get('app.certified.graph.getFollow').defs.main.parameters.required,
    listActorFollowers: byId.get('app.certified.graph.listActorFollowers').defs.main.parameters.required,
    listActorFollowing: byId.get('app.certified.graph.listActorFollowing').defs.main.parameters.required,
  }, {
    getFollow: ['actor', 'subject'],
    listActorFollowers: ['actor'],
    listActorFollowing: ['actor'],
  });
});

test('installed ATProto validator accepts package language, transitive refs, and real fixture records', async () => {
  const { lexicons, isValidDid, isValidTid } = await validatePackageLexicons();
  const { jsonToLex, lexToJson } = await import('@atproto/lexicon');
  for (const record of [...locationRecords, ...profileRecords, ...organizationRecords]) {
    const decoded = jsonToLex(record.record);
    lexicons.assertValidRecord(record.collection, decoded);
    assert.deepEqual(lexToJson(decoded), record.record);
    assert.equal(isValidDid(record.did), true);
    if (record.collection === 'app.certified.location') assert.equal(isValidTid(record.rkey), true);
  }
});

test('fixture CIDs match their DAG-CBOR record contents', async () => {
  const { encode } = await import('@atcute/cbor');
  const CID = await import('@atcute/cid');
  for (const record of [...locationRecords, ...profileRecords, ...organizationRecords]) {
    assert.equal(CID.toString(await CID.create(0x71, encode(record.record))), record.cid);
  }
});

test('record validator rejects malformed embedded location payloads', async () => {
  const { lexicons } = await validatePackageLexicons();
  const { jsonToLex } = await import('@atproto/lexicon');
  const invalidRecord = { ...locationRecords[0].record };
  delete invalidRecord.locationType;
  assert.throws(() => lexicons.assertValidRecord('app.certified.location', jsonToLex(invalidRecord)), /locationType|property/);

  const invalidBlobRecord = structuredClone(locationRecords[2].record);
  invalidBlobRecord.location.blob.ref.$link = 'not-a-cid';
  assert.throws(() => lexicons.assertValidRecord('app.certified.location', jsonToLex(invalidBlobRecord)), /blob ref/);
});
