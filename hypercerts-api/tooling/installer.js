import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLexiconSource } from './lexicon-source.js';

export function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }).map((key) => [key, sortJsonKeys(value[key])]));
  }
  return value;
}

export function compareAsset(asset, installed) {
  if (installed == null) return 'missing';
  if (JSON.stringify(sortJsonKeys(installed.config ?? {})) !== JSON.stringify(sortJsonKeys(asset.config ?? {}))) return 'conflict';
  if (asset.kind === 'lexicon' && JSON.stringify(sortJsonKeys(installed.lexicon_json)) !== JSON.stringify(sortJsonKeys(asset.lexicon_json))) return 'conflict';
  if (asset.kind === 'script' && installed.body !== asset.body) return 'conflict';
  return 'unchanged';
}

function validateAdminUrl(baseUrl) {
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new Error('HappyView admin URL must be a valid HTTP(S) URL');
  }
  const IPV6_ADDRESS_BRACKETS = /^\[|\]$/g;
  const hostname = target.hostname.toLowerCase().replace(IPV6_ADDRESS_BRACKETS, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || (target.protocol === 'http:' && !loopback)) {
    throw new Error('HappyView admin URL must use HTTPS, or HTTP on localhost/127.0.0.1/::1, with no URL credentials');
  }
  return target;
}

function createAdminRequest(target, cookie, fetchImpl) {
  return async function request(method, route, body) {
    let response;
    try {
      response = await fetchImpl(new URL(route, target), {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
      });
    } catch {
      throw new Error(`HappyView ${method} ${route} request failed before receiving a response`);
    }
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) throw new Error(`HappyView ${method} ${route} returned HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

export function createAdminClient({ baseUrl, cookie, fetchImpl = globalThis.fetch }) {
  const target = validateAdminUrl(baseUrl);
  const request = createAdminRequest(target, cookie, fetchImpl);
  return {
    async read(asset) {
      const encoded = encodeURIComponent(asset.id);
      const row = await request('GET', asset.kind === 'lexicon' ? `/admin/lexicons/${encoded}` : `/admin/scripts/${encoded}`);
      if (!row) return null;
      return asset.kind === 'lexicon'
        ? { config: { backfill: row.backfill, target_collection: row.target_collection ?? undefined, action: row.action ?? undefined, token_cost: row.token_cost ?? undefined }, lexicon_json: row.lexicon_json }
        : { config: { script_type: row.script_type, description: row.description ?? undefined }, body: row.body };
    },
    async write(asset) {
      if (asset.kind === 'lexicon') {
        await request('POST', '/admin/lexicons', {
          lexicon_json: asset.lexicon_json,
          backfill: asset.config.backfill,
          target_collection: asset.config.target_collection,
          action: asset.config.action,
          token_cost: asset.config.token_cost,
        });
      } else {
        await request('POST', '/admin/scripts', { id: asset.id, script_type: asset.config.script_type, description: asset.config.description, body: asset.body });
      }
    },
  };
}

export function orderAssets(assets) {
  const byId = new Map();
  for (const asset of assets) {
    if (byId.has(asset.id)) throw new Error(`Duplicate asset ${asset.id}; declare each asset in one module only`);
    byId.set(asset.id, asset);
  }
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(asset) {
    if (visited.has(asset.id)) return;
    if (visiting.has(asset.id)) throw new Error(`Asset dependency cycle at ${asset.id}; remove the circular dependsOn reference before installing`);
    visiting.add(asset.id);
    for (const dependency of asset.dependsOn ?? []) {
      const parent = byId.get(dependency);
      if (!parent) throw new Error(`Missing asset dependency ${dependency} required by ${asset.id}; add its owner module to the bundle before installing`);
      visit(parent);
    }
    visiting.delete(asset.id);
    visited.add(asset.id);
    ordered.push(asset);
  }
  for (const asset of [...assets].sort((a, b) => (a.kind === 'lexicon' ? 0 : 1) - (b.kind === 'lexicon' ? 0 : 1))) visit(asset);
  return ordered;
}

async function preflightAssets(ordered, client) {
  const states = [];
  for (const asset of ordered) {
    const installed = await client.read(asset);
    const state = compareAsset(asset, installed);
    if (state === 'conflict') throw new Error(`Refusing ${asset.id}: unexpected installed difference; inspect and resolve manually before retrying`);
    states.push({ asset, state });
  }
  return states;
}

async function writeMissingAssets(states, client) {
  const changed = [];
  for (let i = 0; i < states.length; i++) {
    const { asset, state } = states[i];
    if (state === 'unchanged') continue;
    try {
      await client.write(asset);
      changed.push(asset.id);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown write failure';
      const error = new Error(`Install partially failed at ${asset.id}: ${reason}; completed: ${changed.join(', ') || '(none)'}; remaining: ${states.slice(i).filter((entry) => entry.state !== 'unchanged').map((entry) => entry.asset.id).join(', ')}`, { cause });
      error.completed = changed;
      error.remaining = states.slice(i).filter((entry) => entry.state !== 'unchanged').map((entry) => entry.asset.id);
      throw error;
    }
  }
  return { changed, unchanged: states.filter((entry) => entry.state === 'unchanged').map(({ asset }) => asset.id) };
}

export async function applyAssets(assets, client) {
  const states = await preflightAssets(orderAssets(assets), client);
  return writeMissingAssets(states, client);
}

// Root manifest (paths are relative to this file):
// { "modules": ["modules/shared/manifest.json", "modules/location/manifest.json"] }
async function readBundleManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`Bundle ${manifestPath} is missing or invalid (${cause.message}); create or fix the root manifest before installing`, { cause });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    throw new Error(`Bundle ${manifestPath} must list at least one module manifest in modules; add a module before installing`);
  }
  return manifest;
}

// Module manifest (asset paths are relative to this module manifest):
// {
//   "assets": [
//     { "id": "org.example.schema", "kind": "lexicon", "path": "schema.json", "config": { "backfill": false } },
//     { "id": "org.example.handler", "kind": "script", "path": "handler.lua", "config": { "script_type": "lua" }, "dependsOn": ["org.example.schema"] }
//   ]
// }
async function readModuleManifest(modulePath, file) {
  let module;
  try {
    module = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new Error(`Module ${modulePath} is missing or invalid (${cause.message}); check the bundle's modules list and module manifest`, { cause });
  }
  if (!module || typeof module !== 'object' || Array.isArray(module) || !Array.isArray(module.assets)) {
    throw new Error(`Module ${modulePath} must declare an assets array; fix its manifest before installing`);
  }
  return module;
}

function validateAssetEntry(entry, modulePath, assetIndex, owners) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id.trim() || !['lexicon', 'script'].includes(entry.kind)) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] needs a nonempty string id and kind lexicon or script; fix this asset before installing`);
  }
  if (entry.dependsOn !== undefined && (!Array.isArray(entry.dependsOn) || entry.dependsOn.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] (${entry.id}) dependsOn must be an array of nonempty string asset IDs; fix its dependencies before installing`);
  }
  if (owners.has(entry.id)) {
    throw new Error(`Duplicate asset ${entry.id} in modules ${owners.get(entry.id)} and ${modulePath}; declare it in one owner only`);
  }
  owners.set(entry.id, modulePath);
  if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] (${entry.id}) config must be a non-array object; fix its configuration before installing`);
  }
}

async function loadAssetSource(asset, modulePath, root) {
  try {
    if (asset.kind === 'lexicon') {
      asset.lexicon_json = await readLexiconSource(asset, root);
      if (asset.lexicon_json?.id !== asset.id) {
        const lexiconId = asset.lexicon_json?.id;
        const displayedId = typeof lexiconId === 'string' ? lexiconId : JSON.stringify(lexiconId) ?? String(lexiconId);
        throw new Error(`lexicon ID ${displayedId} does not match declared asset ID ${asset.id}`);
      }
    } else {
      if (!asset.path) throw new Error('script source path is missing');
      const source = path.resolve(root, asset.path);
      const info = await stat(source);
      if (!info.isFile()) throw new Error('script source is not a file');
      asset.body = await readFile(source, 'utf8');
      if (!asset.body.trim()) throw new Error('script source is empty');
    }
  } catch (cause) {
    throw new Error(`Asset ${asset.id} in module ${modulePath}: source ${asset.path ?? asset.packagePath ?? '(unset)'} is missing, invalid or empty (${cause.message}); fix the declaration or source before installing`, { cause });
  }
}

async function loadModuleAssets(modulePath, file, owners) {
  const module = await readModuleManifest(modulePath, file);
  const assets = [];
  for (const [assetIndex, entry] of module.assets.entries()) {
    validateAssetEntry(entry, modulePath, assetIndex, owners);
    const asset = { ...entry };
    await loadAssetSource(asset, modulePath, path.dirname(file));
    assets.push(asset);
  }
  return assets;
}

/** Load one bundle of module manifests, resolving local sources relative to each module.
 * Validates all local assets and dependencies before admin calls; returns { assets } for applyAssets.
 */
export async function loadAssets(manifestPath) {
  const manifest = await readBundleManifest(manifestPath);
  const assets = [];
  const owners = new Map();
  for (const [moduleIndex, modulePath] of manifest.modules.entries()) {
    if (typeof modulePath !== 'string' || !modulePath.trim()) {
      throw new Error(`Bundle ${manifestPath} modules[${moduleIndex}] must be a nonempty module path; fix the modules list before installing`);
    }
    const file = path.resolve(path.dirname(manifestPath), modulePath);
    assets.push(...await loadModuleAssets(modulePath, file, owners));
  }
  orderAssets(assets);
  return { assets };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see hypercerts-api/README.md`);
  return value;
}

async function main() {
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  const baseUrl = new URL(requiredEnv('HAPPYVIEW_BASE_URL'));
  const cookie = requiredEnv('HAPPYVIEW_SESSION_COOKIE');
  const client = createAdminClient({ baseUrl, cookie });
  const result = await applyAssets(assets, client);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
