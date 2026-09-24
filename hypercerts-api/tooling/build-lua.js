import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const shared = await readFile(path.join(root, 'lua/shared/location.lua'), 'utf8');
for (const name of ['getLocation', 'listLocations']) {
  const endpoint = await readFile(path.join(root, `lua/src/${name}.lua`), 'utf8');
  await writeFile(path.join(root, `lua/endpoints/${name}.lua`), `${shared.trimEnd()}\n\n${endpoint}`);
}
