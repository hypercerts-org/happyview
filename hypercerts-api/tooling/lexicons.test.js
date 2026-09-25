import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { locationRecords, profileRecords, organizationRecords } from '../tests/fixtures/records.js';
import { validatePackageLexicons } from './validate-lexicons.js';
import { readLexiconSource } from './lexicon-source.js';
import { loadAssets } from './installer.js';
import { fileURLToPath } from 'node:url';

test('package-backed Lexicons resolve through the pinned package and install source content matches upstream', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  const packageSources = manifest.validationLexicons.filter(({ packagePath }) => packagePath);
  assert.ok(packageSources.length > 0);
  for (const source of packageSources) {
    const document = await readLexiconSource(source);
    assert.equal(document.id, source.id);
    const asset = assets.find(({ kind, id }) => kind === 'lexicon' && id === source.id);
    assert.ok(asset, `missing install asset ${source.id}`);
    assert.deepEqual(await readLexiconSource(asset), document);
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
