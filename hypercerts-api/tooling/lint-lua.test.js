import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lintLua } from './lint-lua.js';

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hypercerts-api-lint-lua-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('skips Lua lint when the package has no Lua files', async () => {
  await withTempRoot(async (root) => {
    const result = await lintLua({ root, log: () => {} });
    assert.deepEqual(result, { skipped: true });
  });
});

test('requires generated endpoint bundles when Lua sources are present', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'lua', 'src'), { recursive: true });
    await writeFile(path.join(root, 'lua', 'src', 'getExample.lua'), 'function handle() end\n');

    await assert.rejects(
      lintLua({ root, log: () => {} }),
      /generated handler bundles are missing.*pnpm build:lua/,
    );
  });
});

test('runs Luacheck against generated bundles with the package config', async () => {
  await withTempRoot(async (root) => {
    const endpoint = path.join(root, 'lua', 'endpoints', 'getExample.lua');
    await mkdir(path.dirname(endpoint), { recursive: true });
    await writeFile(endpoint, 'function handle() end\n');
    let command;
    let args;
    let options;

    const result = await lintLua({
      root,
      log: () => {},
      spawn: (nextCommand, nextArgs, nextOptions) => {
        command = nextCommand;
        args = nextArgs;
        options = nextOptions;
        return { status: 0 };
      },
    });

    assert.deepEqual(result, { status: 0 });
    assert.equal(command, 'luacheck');
    assert.deepEqual(args, ['--config', '.luacheckrc', 'lua/endpoints/getExample.lua']);
    assert.equal(options.cwd, root);
    assert.equal(options.stdio, 'inherit');
  });
});

test('uses the default user-local LuaRocks binary when it is not on PATH', async () => {
  await withTempRoot(async (root) => {
    const home = path.join(root, 'home');
    const endpoint = path.join(root, 'lua', 'endpoints', 'getExample.lua');
    const localLuacheck = path.join(home, '.luarocks', 'bin', 'luacheck');
    await mkdir(path.dirname(endpoint), { recursive: true });
    await mkdir(path.dirname(localLuacheck), { recursive: true });
    await writeFile(endpoint, 'function handle() end\\n');
    await writeFile(localLuacheck, '#!/bin/sh\\n', { mode: 0o755 });
    const commands = [];

    const result = await lintLua({
      root,
      home,
      log: () => {},
      spawn: (command, args) => {
        commands.push({ command, args });
        if (command === 'luacheck') return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
        return { status: 0 };
      },
    });

    assert.deepEqual(result, { status: 0 });
    assert.deepEqual(commands.map(({ command }) => command), ['luacheck', localLuacheck]);
    assert.deepEqual(commands[1].args, ['--config', '.luacheckrc', 'lua/endpoints/getExample.lua']);
  });
});

test('explains how to install Luacheck when it is missing', async () => {
  await withTempRoot(async (root) => {
    const endpoint = path.join(root, 'lua', 'endpoints', 'getExample.lua');
    await mkdir(path.dirname(endpoint), { recursive: true });
    await writeFile(endpoint, 'function handle() end\n');

    await assert.rejects(
      lintLua({
        root,
        log: () => {},
        spawn: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
      }),
      /Luacheck is missing.*luarocks --lua-version=5\.4 --local install luacheck 1\.2\.0/,
    );
  });
});
