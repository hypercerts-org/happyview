import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const bundles = [
  { shared: ['collection'], endpoints: ['getCollection'] },
  { shared: ['collection', 'collectionList'], endpoints: ['listCollections', 'searchCollections'] },
  { shared: ['activity', 'collectionItems'], endpoints: ['listCollectionItems'] },

  { shared: ['query', 'recordIdentifier', 'recordView', 'actorView', 'location'], endpoints: ['getLocation'] },

  { shared: ['activity'], endpoints: ['getActivity'] },
  { shared: ['query', 'recordIdentifier', 'recordView', 'actorView', 'evaluation'], endpoints: ['getEvaluation'] },
  { shared: ['query', 'recordIdentifier', 'listQuery', 'recordView', 'actorView', 'evaluation', 'evaluationList'], endpoints: ['listEvaluations'] },
  { shared: ['activity', 'activityList'], endpoints: ['listActivities', 'searchActivities'] },
  { shared: ['query', 'recordIdentifier', 'listQuery', 'recordView', 'actorView', 'location'], endpoints: ['listLocations'] },
  { shared: ['query', 'recordView', 'actorFollow', 'actorFollowLookup'], endpoints: ['getFollow'] },
  { shared: ['query', 'recordIdentifier', 'listQuery', 'recordView', 'actorView', 'actorFollow', 'actorFollowList'], endpoints: ['listActorFollowers', 'listActorFollowing'] },
  { shared: ['profile', 'profileLookup'], endpoints: ['getProfile'] },
  { shared: ['profile'], endpoints: ['getProfiles'] },
  { shared: ['profile', 'profileList'], endpoints: ['listProfiles', 'searchProfiles'] },
  { shared: ['organization'], endpoints: ['getOrganization'] },
  { shared: ['organization', 'organizationList'], endpoints: ['listOrganizations', 'searchOrganizations'] },
];

async function renderBundles(root) {
  const outputs = [];
  for (const { shared, endpoints } of bundles) {
    const sharedSources = await Promise.all(shared.map((name) => readFile(path.join(root, `lua/shared/${name}.lua`), 'utf8')));
    for (const name of endpoints) {
      const endpoint = await readFile(path.join(root, `lua/src/${name}.lua`), 'utf8');
      outputs.push({
        path: `lua/endpoints/${name}.lua`,
        content: `${[...sharedSources, endpoint].map((source) => source.trimEnd()).join('\n\n')}\n`,
      });
    }
  }
  return outputs;
}

export async function buildLuaBundles(root) {
  for (const output of await renderBundles(root)) {
    await writeFile(path.join(root, output.path), output.content);
  }
}

export async function checkLuaBundles(root) {
  const stale = [];
  for (const output of await renderBundles(root)) {
    let current;
    try {
      current = await readFile(path.join(root, output.path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        stale.push(output.path);
        continue;
      }
      throw error;
    }
    if (current !== output.content) stale.push(output.path);
  }
  return stale;
}
