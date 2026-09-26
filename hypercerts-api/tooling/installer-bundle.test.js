import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAssets, applyAssets } from './installer.js';

async function bundle(t, modules) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hypercerts-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ modules: Object.keys(modules).map((name) => `${name}/manifest.json`) }));
  for (const [name, { assets, files = {} }] of Object.entries(modules)) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'manifest.json'), JSON.stringify({ assets }));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name, file)), { recursive: true });
      await writeFile(path.join(root, name, file), content);
    }
  }
  return path.join(root, 'manifest.json');
}

function client(installed = {}) {
  const writes = [];
  const reads = [];
  return {
    writes, reads,
    read: async (asset) => { reads.push(asset.id); return installed[asset.id] ?? null; },
    write: async (asset) => { writes.push(asset.id); },
  };
}

test('missing or invalid root bundle identifies its path and how to fix it', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [] } });
  for (const content of ['{', 'null']) {
    await writeFile(manifest, content);
    await assert.rejects(() => loadAssets(manifest), (error) =>
      error.message.includes(manifest) && /bundle/i.test(error.message) && /fix|check|create|add/i.test(error.message));
  }
  await rm(manifest);
  await assert.rejects(() => loadAssets(manifest), (error) =>
    error.message.includes(manifest) && /bundle/i.test(error.message) && /fix|check|create|add/i.test(error.message));
});

test('module paths must be nonempty strings and identify their index', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [] } });
  for (const modulePath of [null, '', '  ', 42]) {
    await writeFile(manifest, JSON.stringify({ modules: [modulePath] }));
    await assert.rejects(() => loadAssets(manifest), /Bundle .*modules\[0\].*nonempty.*path.*fix/i);
  }
});

test('null module manifest identifies the module and corrective action', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [] } });
  await writeFile(path.join(path.dirname(manifest), 'shared/manifest.json'), 'null');
  await assert.rejects(() => loadAssets(manifest), /Module shared\/manifest.json.*assets.*fix|Module shared\/manifest.json.*assets.*check/i);
});

test('invalid asset entries and IDs identify the module and asset index', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [] } });
  const moduleFile = path.join(path.dirname(manifest), 'shared/manifest.json');
  for (const entry of [null, { id: '' }, { id: '  ' }, { id: 3 }, { id: 'valid', kind: 'unknown' }]) {
    await writeFile(moduleFile, JSON.stringify({ assets: [entry] }));
    await assert.rejects(() => loadAssets(manifest), /Module shared\/manifest.json.*assets\[0\].*id.*kind.*fix/i);
  }
});

test('dependsOn must be an array of nonempty string asset IDs', async (t) => {
  const manifest = await bundle(t, { shared: {
    assets: [{ id: 'shared.schema', kind: 'lexicon', path: 'schema.json', config: {} }], files: { 'schema.json': '{"id":"shared.schema"}' },
  } });
  const moduleFile = path.join(path.dirname(manifest), 'shared/manifest.json');
  for (const dependsOn of ['shared.schema', null, [null], [''], [42]]) {
    await writeFile(moduleFile, JSON.stringify({ assets: [{ id: 'shared.schema', kind: 'lexicon', path: 'schema.json', config: {}, dependsOn }] }));
    await assert.rejects(() => loadAssets(manifest), /Module shared\/manifest.json.*assets\[0\].*dependsOn.*array.*nonempty.*fix/i);
  }
});

test('asset config must be a non-array object before any admin calls', async (t) => {
  for (const [name, config] of [['absent', undefined], ['null', null], ['array', []], ['string', 'invalid'], ['number', 7]]) {
    const asset = { id: `org.example.${name}`, kind: 'lexicon', path: 'schema.json' };
    if (config !== undefined) asset.config = config;
    const manifest = await bundle(t, { shared: {
      assets: [asset], files: { 'schema.json': JSON.stringify({ id: asset.id }) },
    } });
    let adminCalls = 0;
    await assert.rejects(async () => {
      const { assets } = await loadAssets(manifest);
      await applyAssets(assets, {
        read: async () => { adminCalls++; return null; },
        write: async () => { adminCalls++; },
      });
    }, /Module shared\/manifest.json.*assets\[0\].*config.*non-array object.*fix/i);
    assert.equal(adminCalls, 0, `${name} config must fail before admin calls`);
  }
});

test('schema-only bundle installs without location handlers or script assets', async (t) => {
  const manifest = await bundle(t, { shared: {
    assets: [{ id: 'org.example.shared', kind: 'lexicon', path: 'schema.json', config: { backfill: false } }],
    files: { 'schema.json': '{"lexicon":1,"id":"org.example.shared"}' },
  } });
  const { assets } = await loadAssets(manifest);
  const admin = client();
  assert.deepEqual(await applyAssets(assets, admin), { changed: ['org.example.shared'], unchanged: [] });
  assert.deepEqual(assets[0].lexicon_json, { lexicon: 1, id: 'org.example.shared' });
});

test('lexicon source ID must match the declared asset ID', async (t) => {
  const manifest = await bundle(t, { shared: {
    assets: [{ id: 'org.example.declared', kind: 'lexicon', path: 'schema.json', config: {} }],
    files: { 'schema.json': '{"id":"org.example.different"}' },
  } });
  await assert.rejects(() => loadAssets(manifest), /Asset org\.example\.declared.*lexicon ID org\.example\.different.*does not match/i);
});

test('composes two domains and one shared owner with cross-module ordering and module-relative sources', async (t) => {
  const manifest = await bundle(t, {
    alpha: { assets: [
      { id: 'alpha.script', kind: 'script', path: 'handler.lua', config: {}, dependsOn: ['beta.schema'] },
    ], files: { 'handler.lua': 'return "alpha"' } },
    beta: { assets: [
      { id: 'beta.schema', kind: 'lexicon', path: 'schema.json', config: {}, dependsOn: ['shared.schema'] },
    ], files: { 'schema.json': '{"id":"beta.schema"}' } },
    shared: { assets: [
      { id: 'shared.schema', kind: 'lexicon', path: 'schema.json', config: {} },
    ], files: { 'schema.json': '{"id":"shared.schema"}' } },
  });
  const { assets } = await loadAssets(manifest);
  assert.equal(assets.find(({ id }) => id === 'alpha.script').body, 'return "alpha"');
  const admin = client();
  await applyAssets(assets, admin);
  assert.deepEqual(admin.writes, ['shared.schema', 'beta.schema', 'alpha.script']);
});

test('missing, non-file or empty script sources fail during loading before admin calls', async (t) => {
  for (const [name, files] of [['missing', {}], ['empty', { 'handler.lua': ' \n ' }], ['directory', { 'handler.lua/child': 'content' }]]) {
    const manifest = await bundle(t, { [name]: { assets: [
      { id: `${name}.script`, kind: 'script', path: 'handler.lua', config: {} },
    ], files } });
    await assert.rejects(() => loadAssets(manifest), (error) =>
      error.message.includes(`${name}.script`) && error.message.includes(name) && /source|empty|missing/i.test(error.message));
  }
});

test('missing module manifest identifies the module and repair action', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [] } });
  await rm(path.join(path.dirname(manifest), 'shared/manifest.json'));
  await assert.rejects(() => loadAssets(manifest), /Module shared\/manifest.json.*missing.*check.*module/i);
});

test('packagePath Lexicons still load from the installed package', async (t) => {
  const manifest = await bundle(t, { shared: { assets: [
    { id: 'org.hypercerts.defs', kind: 'lexicon', packagePath: 'lexicons/org/hypercerts/defs.json', config: { backfill: false } },
  ] } });
  const { assets } = await loadAssets(manifest);
  assert.equal(assets[0].lexicon_json.id, 'org.hypercerts.defs');
});

test('duplicate asset IDs across modules are rejected instead of silently selecting one', async (t) => {
  const manifest = await bundle(t, {
    alpha: { assets: [{ id: 'shared.schema', kind: 'lexicon', path: 'schema.json', config: {} }], files: { 'schema.json': '{"id":"shared.schema"}' } },
    beta: { assets: [{ id: 'shared.schema', kind: 'lexicon', path: 'schema.json', config: {} }], files: { 'schema.json': '{"id":"shared.schema"}' } },
  });
  await assert.rejects(() => loadAssets(manifest), /Duplicate asset shared\.schema.*alpha.*beta/);
});

test('missing dependencies and cross-module cycles refuse the combined bundle before reads or writes', async (t) => {
  for (const [name, dependency, other] of [
    ['missing', 'absent', []],
    ['cycle', 'beta.schema', [{ id: 'beta.schema', kind: 'lexicon', path: 'schema.json', config: {}, dependsOn: ['alpha.schema'] }]],
  ]) {
    const manifest = await bundle(t, {
      alpha: { assets: [{ id: 'alpha.schema', kind: 'lexicon', path: 'schema.json', config: {}, dependsOn: [dependency] }], files: { 'schema.json': '{"id":"alpha.schema"}' } },
      beta: { assets: other, files: { 'schema.json': '{"id":"beta.schema"}' } },
    });
    await assert.rejects(() => loadAssets(manifest), name === 'missing' ? /Missing asset dependency.*absent/ : /cycle/);
  }
});

test('conflict in later module prevents writes in earlier modules', async (t) => {
  const manifest = await bundle(t, {
    first: { assets: [{ id: 'first.schema', kind: 'lexicon', path: 'schema.json', config: { backfill: false } }], files: { 'schema.json': '{"id":"first.schema"}' } },
    later: { assets: [{ id: 'later.schema', kind: 'lexicon', path: 'schema.json', config: { backfill: false } }], files: { 'schema.json': '{"id":"later.schema"}' } },
  });
  const { assets } = await loadAssets(manifest);
  const admin = client({ 'later.schema': { config: { backfill: true }, lexicon_json: {} } });
  await assert.rejects(() => applyAssets(assets, admin), /Refusing later.schema/);
  assert.deepEqual(admin.reads, ['first.schema', 'later.schema']);
  assert.deepEqual(admin.writes, []);
});
