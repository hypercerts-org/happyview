import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('CLI requires a nonblank admin token and does not fall back to a session cookie', () => {
  const script = fileURLToPath(new URL('./installer.js', import.meta.url));
  for (const token of [undefined, '', ' \t']) {
    const env = {
      PATH: process.env.PATH ?? '',
      HAPPYVIEW_BASE_URL: 'http://127.0.0.1:8080',
      HAPPYVIEW_SESSION_COOKIE: 'session=legacy-secret',
    };
    if (token !== undefined) env.HAPPYVIEW_ADMIN_TOKEN = token;
    const child = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /HAPPYVIEW_ADMIN_TOKEN.*README/);
    assert.doesNotMatch(child.stderr, /legacy-secret|manifest\.json/);
  }
});

test('importing the installer does not run the CLI or require configuration', () => {
  const script = fileURLToPath(new URL('./installer.js', import.meta.url));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(script).href], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('CLI main-module detection works when the checkout path contains #', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happyview#installer-cli-'));
  try {
    const tooling = path.join(root, 'tooling');
    const shared = path.join(root, 'shared');
    await mkdir(tooling);
    await mkdir(shared);
    const script = path.join(tooling, 'installer.js');
    await copyFile(fileURLToPath(new URL('./installer.js', import.meta.url)), script);
    await writeFile(path.join(tooling, 'lexicon-source.js'), 'export async function readLexiconSource() { return {}; }');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ modules: ['shared/manifest.json'] }));
    await writeFile(path.join(shared, 'manifest.json'), JSON.stringify({
      assets: [{ id: 'org.example.missing', kind: 'script', config: { script_type: 'query' }, path: 'missing.lua' }],
    }));

    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HAPPYVIEW_BASE_URL: 'http://127.0.0.1:8000',
        HAPPYVIEW_ADMIN_TOKEN: 'hv_cli-test-token',
      },
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /source missing\.lua is missing/);
    assert.doesNotMatch(child.stderr, /HAPPYVIEW_(BASE_URL|ADMIN_TOKEN) is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
