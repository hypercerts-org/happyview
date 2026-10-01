import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function lintLua(file) {
  const args = ['--config', '.luacheckrc', '--no-color', file];
  let result = spawnSync('luacheck', args, { cwd: packageRoot, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    result = spawnSync(path.join(os.homedir(), '.luarocks', 'bin', 'luacheck'), args, {
      cwd: packageRoot,
      encoding: 'utf8',
    });
  }
  assert.ifError(result.error);
  return result;
}

test('Luacheck distinguishes HappyView sandbox APIs from Lua 5.4 globals', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hypercerts-lint-'));
  const file = path.join(directory, 'handler.lua');
  try {
    await writeFile(file, 'function handle() return io.open("file"), os.execute("true") end\n');
    const rejected = lintLua(file);
    assert.notEqual(rejected.status, 0, 'sandbox-removed APIs should fail lint');
    assert.match(rejected.stdout, /undefined variable 'io'/);
    assert.match(rejected.stdout, /undefined field 'execute'/);

    await writeFile(file, 'function handle() return db.backend(), json.encode(params), toarray({}), os.time() end\n');
    const accepted = lintLua(file);
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
