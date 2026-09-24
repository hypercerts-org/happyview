import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLexiconSource } from './lexicon-source.js';

export function semanticJson(value) {
  if (Array.isArray(value)) return value.map(semanticJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }).map((key) => [key, semanticJson(value[key])]));
  }
  return value;
}

export function compareAsset(asset, installed) {
  if (installed == null) return 'missing';
  if (JSON.stringify(semanticJson(installed.config ?? {})) !== JSON.stringify(semanticJson(asset.config ?? {}))) return 'conflict';
  if (asset.kind === 'lexicon' && JSON.stringify(semanticJson(installed.lexicon_json)) !== JSON.stringify(semanticJson(asset.lexicon_json))) return 'conflict';
  if (asset.kind === 'script' && installed.body !== asset.body) return 'conflict';
  return 'unchanged';
}

export function assertInstallable(manifest, root = process.cwd()) {
  const requiredHandlers = ['getLocation', 'listLocations'];
  const pending = requiredHandlers.filter((name) => manifest.handlerStatus?.[name] !== 'implemented');
  if (pending.length) throw new Error(`Cannot apply location package until real Lua handlers exist: ${pending.join(', ')}`);
  const scripts = new Map((manifest.assets ?? []).filter(({ kind }) => kind === 'script').map((asset) => [asset.id, asset]));
  for (const name of requiredHandlers) {
    const id = `xrpc.query:app.certified.location.${name}`;
    const asset = scripts.get(id);
    const source = asset?.path && root ? path.resolve(root, asset.path) : undefined;
    if (!source || !existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`Cannot apply location package: real Lua handler source is missing for ${id}`);
    }
  }
}

export function createAdminClient({ baseUrl, cookie, fetchImpl = globalThis.fetch }) {
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new Error('HappyView admin URL must be a valid HTTP(S) URL');
  }
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || (target.protocol === 'http:' && !loopback)) {
    throw new Error('HappyView admin URL must use HTTPS, or HTTP on localhost/127.0.0.1/::1, with no URL credentials');
  }
  async function request(method, route, body) {
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
  }
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
        await request('POST', '/admin/lexicons', { lexicon_json: asset.lexicon_json, backfill: asset.config.backfill, target_collection: asset.config.target_collection });
      } else {
        await request('POST', '/admin/scripts', { id: asset.id, script_type: asset.config.script_type, description: asset.config.description, body: asset.body });
      }
    },
  };
}

export function orderAssets(assets) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(asset) {
    if (visited.has(asset.id)) return;
    if (visiting.has(asset.id)) throw new Error(`Asset dependency cycle at ${asset.id}`);
    visiting.add(asset.id);
    for (const dependency of asset.dependsOn ?? []) {
      const parent = byId.get(dependency);
      if (!parent) throw new Error(`Missing asset dependency ${dependency} required by ${asset.id}`);
      visit(parent);
    }
    visiting.delete(asset.id);
    visited.add(asset.id);
    ordered.push(asset);
  }
  for (const asset of [...assets].sort((a, b) => (a.kind === 'lexicon' ? 0 : 1) - (b.kind === 'lexicon' ? 0 : 1))) visit(asset);
  return ordered;
}

export async function applyAssets(assets, client) {
  const ordered = orderAssets(assets);
  const states = [];
  for (const asset of ordered) {
    const installed = await client.read(asset);
    const state = compareAsset(asset, installed);
    if (state === 'conflict') throw new Error(`Refusing ${asset.id}: unexpected installed difference; inspect and resolve manually before retrying`);
    states.push({ asset, state });
  }
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

async function loadAssets(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const root = path.dirname(manifestPath);
  assertInstallable(manifest, root);
  const assets = await Promise.all(manifest.assets.map(async (entry) => {
    const asset = { ...entry };
    if (entry.kind === 'lexicon') asset.lexicon_json = await readLexiconSource(entry, root);
    else asset.body = await readFile(path.join(root, entry.path), 'utf8');
    return asset;
  }));
  return { manifest, root, assets };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see hypercerts-api/README.md`);
  return value;
}

async function main() {
  const { manifest, root, assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  assertInstallable(manifest, root);
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
