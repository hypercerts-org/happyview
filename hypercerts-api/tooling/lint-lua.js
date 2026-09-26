import { access, readdir } from 'node:fs/promises';
import { X_OK } from 'node:constants';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

async function luaFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await luaFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.lua')) files.push(file);
  }
  return files;
}

export async function lintLua({ root = defaultRoot, home = homedir(), spawn = spawnSync, log = console.log } = {}) {
  const allFiles = await luaFiles(path.join(root, 'lua'));
  if (allFiles.length === 0) {
    log('No Lua files in this branch; skipping Luacheck.');
    return { skipped: true };
  }

  const endpointFiles = await luaFiles(path.join(root, 'lua', 'endpoints'));
  if (endpointFiles.length === 0) {
    throw new Error('Lua sources exist, but generated handler bundles are missing; run `pnpm build:lua` first.');
  }

  const args = [
    '--config',
    '.luacheckrc',
    ...endpointFiles.map((file) => path.relative(root, file)),
  ];
  const options = { cwd: root, stdio: 'inherit' };
  let result = spawn('luacheck', args, options);
  if (result.error?.code === 'ENOENT') {
    const localLuacheck = path.join(home, '.luarocks', 'bin', 'luacheck');
    try {
      await access(localLuacheck, X_OK);
      result = spawn(localLuacheck, args, options);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  if (result.error?.code === 'ENOENT') {
    throw new Error('Luacheck is missing. Install it with `luarocks --lua-version=5.4 --local install luacheck 1.2.0`.');
  }
  if (result.error) throw result.error;
  return { status: result.status ?? 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await lintLua();
    if (result.status !== undefined) process.exitCode = result.status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
