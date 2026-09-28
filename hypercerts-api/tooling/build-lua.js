import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundles = [
  { shared: ['location'], endpoints: ['getLocation', 'listLocations'] },
  { shared: ['actorFollow', 'actorFollowLookup'], endpoints: ['getFollow'] },
  { shared: ['actorFollow', 'actorFollowList'], endpoints: ['listActorFollowers', 'listActorFollowing'] },
];

for (const { shared, endpoints } of bundles) {
  const sharedSources = await Promise.all(shared.map((name) => readFile(path.join(root, `lua/shared/${name}.lua`), 'utf8')));
  for (const name of endpoints) {
    const endpoint = await readFile(path.join(root, `lua/src/${name}.lua`), 'utf8');
    await writeFile(path.join(root, `lua/endpoints/${name}.lua`), `${[...sharedSources, endpoint].map((source) => source.trimEnd()).join('\n\n')}\n`);
  }
}
