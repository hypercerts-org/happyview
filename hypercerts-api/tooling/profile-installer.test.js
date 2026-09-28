import test from 'node:test';
import assert from 'node:assert/strict';
import * as installer from './installer.js';

const resolverKey = 'HYPERCERTS_HANDLE_RESOLVER_URL';
const profileHandlerId = 'xrpc.query:app.certified.actor.getProfile';

function assets(ids = [profileHandlerId, 'org.example.other']) {
  return ids.map((id) => ({
    id,
    kind: 'script',
    config: { script_type: 'lua' },
    body: `handler ${id}`,
  }));
}

function fakeAdmin({ variables = [], conflictId, listFailure, createFailure, writeFailure } = {}) {
  const events = [];
  return {
    events,
    async read(asset) {
      events.push(['read', asset.id]);
      return asset.id === conflictId ? { config: asset.config, body: 'different handler' } : null;
    },
    async write(asset) {
      events.push(['write', asset.id]);
      if (asset.id === writeFailure) throw new Error('script write failed');
    },
    async listScriptVariables() {
      events.push(['list-script-variables']);
      if (listFailure) throw listFailure;
      return variables;
    },
    async createScriptVariable(key, value) {
      events.push(['create-script-variable', key, value]);
      if (createFailure) throw createFailure;
    },
  };
}

function apply(assetsToInstall, admin, options = {}) {
  assert.equal(typeof installer.applyAssets, 'function');
  return installer.applyAssets(assetsToInstall, admin, options);
}

test('profile install prompts for resolver URL after asset preflight and creates it before scripts', async () => {
  const admin = fakeAdmin();
  const prompts = [];
  const output = [];
  const result = await apply(assets(), admin, {
    env: {},
    isTTY: true,
    ask: async (label) => { prompts.push(label); return 'https://resolver.example'; },
    onNotice: (message) => output.push(message),
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /resolver/i);
  const lastAssetRead = Math.max(...admin.events.map((event, index) => event[0] === 'read' ? index : -1));
  const listIndex = admin.events.findIndex(([name]) => name === 'list-script-variables');
  const createIndex = admin.events.findIndex(([name]) => name === 'create-script-variable');
  const profileWriteIndex = admin.events.findIndex(([name, id]) => name === 'write' && id === profileHandlerId);
  assert.ok(lastAssetRead < listIndex, 'all asset conflict reads precede the script-variable preflight');
  assert.ok(listIndex < createIndex && createIndex < profileWriteIndex);
  assert.deepEqual(admin.events[createIndex], ['create-script-variable', resolverKey, 'https://resolver.example']);
  assert.equal(result.resolverSetting.status, 'created');
  assert.deepEqual(output, []);
});

test('noninteractive install uses and validates the resolver URL from the environment', async () => {
  const admin = fakeAdmin();
  const result = await apply(assets([profileHandlerId]), admin, {
    env: { [resolverKey]: 'https://resolver.example/' },
    isTTY: false,
    ask: async () => { assert.fail('noninteractive install must not prompt'); },
  });

  assert.ok(admin.events.some((event) => event[0] === 'create-script-variable' && event[1] === resolverKey && event[2] === 'https://resolver.example'));
  assert.equal(result.resolverSetting.status, 'created');
});

test('installer accepts a valid bracketed IPv6 resolver origin', async () => {
  const admin = fakeAdmin();
  await apply(assets([profileHandlerId]), admin, {
    env: { [resolverKey]: 'https://[2001:db8::1]' }, isTTY: false,
  });

  assert.ok(admin.events.some((event) => event[0] === 'create-script-variable'
    && event[1] === resolverKey && event[2] === 'https://[2001:db8::1]'));
});

test('profile install rejects unsafe resolver URLs before setting creation or asset writes', async () => {
  for (const value of [
    'http://resolver.example',
    'https://user:secret@resolver.example',
    'https://resolver.example?tenant=one',
    'https://resolver.example/path',
    'https://resolver.example//',
    'https://resolver.example:',
    'https://resolver.example:0',
    'https://resolver..example',
    'https://-resolver.example',
    'https://resolver.example#fragment',
    'https://[:::]',
    'https://resolver.example\\@evil.example',
  ]) {
    const admin = fakeAdmin();
    await assert.rejects(() => apply(assets(), admin, {
      env: { [resolverKey]: value }, isTTY: false,
    }), (error) => /HYPERCERTS_HANDLE_RESOLVER_URL/.test(error.message) && /HTTPS|valid/i.test(error.message));
    assert.equal(admin.events.some(([name]) => name === 'create-script-variable' || name === 'write'), false, value);
  }
});

test('existing resolver setting is preserved without a needless prompt and is reported as unverifiable', async () => {
  const admin = fakeAdmin({ variables: [{ key: resolverKey, preview: 'http****' }] });
  const messages = [];
  const result = await apply(assets([profileHandlerId]), admin, {
    env: {}, isTTY: true,
    ask: async () => { assert.fail('existing resolver setting must not prompt'); },
    onNotice: (message) => messages.push(message),
  });

  assert.equal(admin.events.some(([name]) => name === 'create-script-variable'), false);
  assert.equal(result.resolverSetting.status, 'exists-unverified');
  assert.match(messages.join('\n'), new RegExp(`${resolverKey}.*already exists.*actual value cannot be verified`, 'i'));
});

test('bundles without getProfile do not require or inspect the resolver setting', async () => {
  const admin = fakeAdmin();
  const result = await apply(assets(['org.example.other']), admin, { env: {}, isTTY: false });

  assert.deepEqual(result, { changed: ['org.example.other'], unchanged: [] });
  assert.equal(admin.events.some(([name]) => name === 'list-script-variables' || name === 'create-script-variable'), false);
});

test('asset conflicts are all preflighted before resolver setting interaction or writes', async () => {
  const admin = fakeAdmin({ conflictId: 'org.example.conflict' });
  const prompts = [];
  await assert.rejects(() => apply(assets([profileHandlerId, 'org.example.conflict']), admin, {
    env: {}, isTTY: true,
    ask: async (label) => { prompts.push(label); return 'https://resolver.example'; },
  }), /Refusing org\.example\.conflict/);

  assert.deepEqual(admin.events.filter(([name]) => name === 'read').map(([, id]) => id), [profileHandlerId, 'org.example.conflict']);
  assert.equal(admin.events.some(([name]) => name === 'list-script-variables' || name === 'create-script-variable' || name === 'write'), false);
  assert.deepEqual(prompts, []);
});

test('resolver setting permission failures explain the required token scopes', async () => {
  const readAdmin = fakeAdmin({ listFailure: new Error('HappyView GET /admin/script-variables returned HTTP 403') });
  await assert.rejects(() => apply(assets([profileHandlerId]), readAdmin, {
    env: {}, isTTY: false,
  }), /script-variables:read/);

  const createAdmin = fakeAdmin({ createFailure: new Error('HappyView POST /admin/script-variables returned HTTP 403') });
  await assert.rejects(() => apply(assets([profileHandlerId]), createAdmin, {
    env: { [resolverKey]: 'https://resolver.example' }, isTTY: false,
  }), /script-variables:create/);
  assert.equal(createAdmin.events.some(([name]) => name === 'write'), false);
});

test('failure after resolver creation reports the retained setting and partial installation', async () => {
  const admin = fakeAdmin({ writeFailure: profileHandlerId });
  await assert.rejects(() => apply(assets([profileHandlerId]), admin, {
    env: { [resolverKey]: 'https://resolver.example' }, isTTY: false,
  }), (error) => /partially failed/i.test(error.message)
    && error.message.includes(resolverKey)
    && /creat(?:ed|ing).*remains|remains.*creat(?:ed|ing)/i.test(error.message));
  assert.ok(admin.events.some(([name]) => name === 'create-script-variable'));
});

test('admin client uses the script-variable list and upsert routes with the exact setting body', async () => {
  const calls = [];
  const responses = [
    new Response(JSON.stringify([{ key: resolverKey, preview: 'http****' }]), { status: 200 }),
    new Response(null, { status: 204 }),
  ];
  const admin = installer.createAdminClient({
    baseUrl: 'https://happyview.example',
    token: 'hv_fake-admin-token',
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return responses.shift(); },
  });

  assert.deepEqual(await admin.listScriptVariables(), [{ key: resolverKey, preview: 'http****' }]);
  await admin.createScriptVariable(resolverKey, 'https://resolver.example');
  assert.equal(calls[0].url, 'https://happyview.example/admin/script-variables');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url, 'https://happyview.example/admin/script-variables');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { key: resolverKey, value: 'https://resolver.example' });
});
