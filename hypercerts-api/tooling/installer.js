import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLexiconSource } from './lexicon-source.js';

/** @typedef {Record<string, unknown> & { backfill?: boolean; target_collection?: string; action?: string; token_cost?: number }} LexiconAssetConfig */
/** @typedef {Record<string, unknown> & { script_type?: string; description?: string }} ScriptAssetConfig */
/** @typedef {LexiconAssetConfig | ScriptAssetConfig} AssetConfig */
/** @typedef {Record<string, unknown> & { id: string; kind: 'lexicon' | 'script' }} AssetCandidate */
/** @typedef {Record<string, unknown> & { modules: string[] }} BundleManifest */
/** @typedef {Record<string, unknown> & { id: string; kind: 'lexicon'; config: LexiconAssetConfig; dependsOn?: string[]; path?: string; packagePath?: string }} LexiconManifestAsset */
/** @typedef {Record<string, unknown> & { id: string; kind: 'script'; config: ScriptAssetConfig; dependsOn?: string[]; path?: string }} ScriptManifestAsset */
/** @typedef {LexiconManifestAsset | ScriptManifestAsset} ValidatedManifestAsset */
/** @typedef {Record<string, unknown> & { assets: ValidatedManifestAsset[] }} ModuleManifest */
/** @typedef {LexiconManifestAsset & { lexicon_json: unknown }} LoadedLexiconAsset */
/** @typedef {ScriptManifestAsset & { path: string; body: string }} LoadedScriptAsset */
/** @typedef {LoadedLexiconAsset | LoadedScriptAsset} LoadedAsset */
/** @typedef {{ id: string; kind?: 'lexicon' | 'script'; dependsOn?: string[] }} OrderableAsset */
/** @typedef {'missing' | 'unchanged'} InstallState */
/** @typedef {{ asset: LoadedAsset; state: InstallState }} AssetInstallState */
/** @typedef {{ config?: AssetConfig | null; lexicon_json?: unknown; body?: unknown }} InstalledAsset */
/** External GET /admin/lexicons/:id response assertion; response.json() is not runtime-validated. @typedef {{ backfill: boolean; target_collection: string | null; action: string | null; token_cost: number | null; lexicon_json: unknown }} LexiconAdminRow */
/** External GET /admin/scripts/:id response assertion; response.json() is not runtime-validated. @typedef {{ script_type: string; description: string | null; body: string }} ScriptAdminRow */
/** @typedef {{ read: (asset: LoadedAsset) => Promise<InstalledAsset | null>; write: (asset: LoadedAsset) => Promise<void> }} AdminClient */
/** @typedef {{ changed: string[]; unchanged: string[] }} InstallResult */
/** @typedef {Error & { completed: string[]; remaining: string[] }} PartialInstallError */

const require = createRequire(new URL('../package.json', import.meta.url));

/** @param {unknown} value @returns {unknown} */
export function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(value).sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }).map((key) => [key, sortJsonKeys(record[key])]));
  }
  return value;
}

/** @param {unknown} document @returns {unknown} */
function canonicalizeLexiconRefs(document) {
  // HappyView stores canonical `lex:` refs; package schemas may use unprefixed refs.
  const { Lexicons } = require('@atproto/lexicon');
  // Lexicons performs the existing runtime document validation at this boundary.
  const canonical = /** @type {import('@atproto/lexicon').LexiconDoc} */ (structuredClone(document));
  const lexicons = new Lexicons([canonical]);
  return lexicons.get(canonical.id);
}

/** @param {LoadedAsset} asset @param {InstalledAsset | null} installed @returns {'missing' | 'conflict' | 'unchanged'} */
export function compareAsset(asset, installed) {
  if (installed == null) return 'missing';
  const declaredConfig = asset.config ?? {};
  const installedConfig = Object.fromEntries(Object.keys(declaredConfig).map((key) => [key, installed.config?.[key]]));
  if (JSON.stringify(sortJsonKeys(installedConfig)) !== JSON.stringify(sortJsonKeys(declaredConfig))) return 'conflict';
  if (asset.kind === 'lexicon') {
    if (installed.lexicon_json == null) return 'conflict';
    const installedLexicon = canonicalizeLexiconRefs(installed.lexicon_json);
    const declaredLexicon = canonicalizeLexiconRefs(asset.lexicon_json);
    if (JSON.stringify(sortJsonKeys(installedLexicon)) !== JSON.stringify(sortJsonKeys(declaredLexicon))) return 'conflict';
  }
  if (asset.kind === 'script' && installed.body !== asset.body) return 'conflict';
  return 'unchanged';
}

/** @param {string | URL} baseUrl @returns {URL} */
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

/** @param {URL} target @param {string} token @param {typeof globalThis.fetch} fetchImpl */
function createAdminRequest(target, token, fetchImpl) {
  return /** @param {'GET' | 'POST'} method @param {string} route @param {unknown} [body] */ async function request(method, route, body) {
    let response;
    try {
      response = await fetchImpl(new URL(route, target), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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

/** @param {{ baseUrl: string | URL; token: string; fetchImpl?: typeof globalThis.fetch }} options */
export function createAdminClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('HAPPYVIEW_ADMIN_TOKEN is required and must not be blank; set it before running the installer (see hypercerts-api/README.md)');
  }
  const target = validateAdminUrl(baseUrl);
  const request = createAdminRequest(target, token.trim(), fetchImpl);
  return {
    /** @param {LoadedAsset} asset */
    async read(asset) {
      const encoded = encodeURIComponent(asset.id);
      const row = await request('GET', asset.kind === 'lexicon' ? `/admin/lexicons/${encoded}` : `/admin/scripts/${encoded}`);
      if (!row) return null;
      if (asset.kind === 'lexicon') {
        const lexiconRow = /** @type {LexiconAdminRow} */ (row);
        return { config: { backfill: lexiconRow.backfill, target_collection: lexiconRow.target_collection ?? undefined, action: lexiconRow.action ?? undefined, token_cost: lexiconRow.token_cost ?? undefined }, lexicon_json: lexiconRow.lexicon_json };
      }
      const scriptRow = /** @type {ScriptAdminRow} */ (row);
      return { config: { script_type: scriptRow.script_type, description: scriptRow.description ?? undefined }, body: scriptRow.body };
    },
    /** @param {LoadedAsset} asset */
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

/**
 * @template {OrderableAsset} T
 * @param {T[]} assets
 * @returns {T[]}
 */
export function orderAssets(assets) {
  /** @type {Map<string, T>} */
  const byId = new Map();
  for (const asset of assets) {
    if (byId.has(asset.id)) throw new Error(`Duplicate asset ${asset.id}; declare each asset in one module only`);
    byId.set(asset.id, asset);
  }
  /** @type {T[]} */
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  /** @param {T} asset */
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

/** @param {LoadedAsset[]} ordered @param {AdminClient} client @returns {Promise<AssetInstallState[]>} */
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

/** @param {AssetInstallState[]} states @param {AdminClient} client @returns {Promise<InstallResult>} */
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
      const error = /** @type {PartialInstallError} */ (new Error(`Install partially failed at ${asset.id}: ${reason}; completed: ${changed.join(', ') || '(none)'}; remaining: ${states.slice(i).filter((entry) => entry.state !== 'unchanged').map((entry) => entry.asset.id).join(', ')}`, { cause }));
      error.completed = changed;
      error.remaining = states.slice(i).filter((entry) => entry.state !== 'unchanged').map((entry) => entry.asset.id);
      throw error;
    }
  }
  return { changed, unchanged: states.filter((entry) => entry.state === 'unchanged').map(({ asset }) => asset.id) };
}

/** @param {LoadedAsset[]} assets @param {AdminClient} client @returns {Promise<InstallResult>} */
export async function applyAssets(assets, client) {
  const states = await preflightAssets(orderAssets(assets), client);
  return writeMissingAssets(states, client);
}

// Root manifest (paths are relative to this file):
// { "modules": ["modules/shared/manifest.json", "modules/location/manifest.json"] }
/** @param {string} manifestPath @returns {Promise<BundleManifest>} */
async function readBundleManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    // readFile and JSON.parse throw Error instances; preserve their original message interpolation.
    const detail = /** @type {Error} */ (cause).message;
    throw new Error(`Bundle ${manifestPath} is missing or invalid (${detail}); create or fix the root manifest before installing`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Bundle ${manifestPath} must list at least one module manifest in modules; add a module before installing`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(candidate.modules) || candidate.modules.length === 0) {
    throw new Error(`Bundle ${manifestPath} must list at least one module manifest in modules; add a module before installing`);
  }
  /** @type {string[]} */
  const modules = [];
  for (const [moduleIndex, modulePath] of candidate.modules.entries()) {
    if (typeof modulePath !== 'string' || !modulePath.trim()) {
      throw new Error(`Bundle ${manifestPath} modules[${moduleIndex}] must be a nonempty module path; fix the modules list before installing`);
    }
    modules.push(modulePath);
  }
  return { ...candidate, modules };
}

// Module manifest (asset paths are relative to this module manifest):
// {
//   "assets": [
//     { "id": "org.example.schema", "kind": "lexicon", "path": "schema.json", "config": { "backfill": false } },
//     { "id": "org.example.handler", "kind": "script", "path": "handler.lua", "config": { "script_type": "lua" }, "dependsOn": ["org.example.schema"] }
//   ]
// }
/** @param {string} modulePath @param {string} file @param {Map<string, string>} owners @returns {Promise<ModuleManifest>} */
async function readModuleManifest(modulePath, file, owners) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    // readFile and JSON.parse throw Error instances; preserve their original message interpolation.
    const detail = /** @type {Error} */ (cause).message;
    throw new Error(`Module ${modulePath} is missing or invalid (${detail}); check the bundle's modules list and module manifest`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Module ${modulePath} must declare an assets array; fix its manifest before installing`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(candidate.assets)) {
    throw new TypeError(`Module ${modulePath} must declare an assets array; fix its manifest before installing`);
  }
  /** @type {ValidatedManifestAsset[]} */
  const assets = [];
  for (const [assetIndex, entry] of candidate.assets.entries()) {
    assets.push(validateAssetEntry(entry, modulePath, assetIndex, owners));
  }
  return { ...candidate, assets };
}

/** @param {unknown} entry @param {string} modulePath @param {number} assetIndex @returns {AssetCandidate} */
function validateAssetShape(entry, modulePath, assetIndex) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] needs a nonempty string id and kind lexicon or script; fix this asset before installing`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (entry);
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || (candidate.kind !== 'lexicon' && candidate.kind !== 'script')) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] needs a nonempty string id and kind lexicon or script; fix this asset before installing`);
  }
  return /** @type {AssetCandidate} */ (candidate);
}

/** @param {AssetCandidate} candidate @param {string} modulePath @param {number} assetIndex */
function validateAssetDependencies(candidate, modulePath, assetIndex) {
  if (candidate.dependsOn !== undefined && (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] (${candidate.id}) dependsOn must be an array of nonempty string asset IDs; fix its dependencies before installing`);
  }
}

/** @param {string} id @param {string} modulePath @param {Map<string, string>} owners */
function claimAssetOwnership(id, modulePath, owners) {
  if (owners.has(id)) {
    throw new Error(`Duplicate asset ${id} in modules ${owners.get(id)} and ${modulePath}; declare it in one owner only`);
  }
  owners.set(id, modulePath);
}

/** @param {string} field @param {unknown} value @param {string} expectedType @returns {boolean} */
function isValidConfigValue(field, value, expectedType) {
  return field === 'token_cost'
    ? typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
    : typeof value === expectedType;
}

/** @param {AssetCandidate} candidate @param {string} modulePath @param {number} assetIndex */
function validateAssetConfig(candidate, modulePath, assetIndex) {
  if (!candidate.config || typeof candidate.config !== 'object' || Array.isArray(candidate.config)) {
    throw new Error(`Module ${modulePath} assets[${assetIndex}] (${candidate.id}) config must be a non-array object; fix its configuration before installing`);
  }
  const config = /** @type {Record<string, unknown>} */ (candidate.config);
  const configFieldTypes = candidate.kind === 'lexicon'
    ? { backfill: 'boolean', target_collection: 'string', action: 'string', token_cost: 'number' }
    : { script_type: 'string', description: 'string' };
  for (const [field, expectedType] of Object.entries(configFieldTypes)) {
    const value = config[field];
    const valid = isValidConfigValue(field, value, expectedType);
    if (value !== undefined && !valid) {
      const expected = field === 'token_cost' ? 'a signed 32-bit integer' : `a ${expectedType}`;
      throw new Error(`Module ${modulePath} assets[${assetIndex}] (${candidate.id}) config.${field} must be ${expected} when provided; fix its configuration before installing`);
    }
  }
}

/** @param {AssetCandidate} candidate @param {string} modulePath @param {number} assetIndex */
function validateAssetSourcePaths(candidate, modulePath, assetIndex) {
  const sourceFields = candidate.kind === 'lexicon' ? ['path', 'packagePath'] : ['path'];
  for (const field of sourceFields) {
    const sourcePath = candidate[field];
    if (sourcePath !== undefined && (typeof sourcePath !== 'string' || !sourcePath.trim())) {
      throw new Error(`Module ${modulePath} assets[${assetIndex}] (${candidate.id}) ${field} must be a nonempty string path when provided; fix its source declaration before installing`);
    }
  }
}

/** @param {unknown} entry @param {string} modulePath @param {number} assetIndex @param {Map<string, string>} owners @returns {ValidatedManifestAsset} */
function validateAssetEntry(entry, modulePath, assetIndex, owners) {
  const candidate = validateAssetShape(entry, modulePath, assetIndex);
  validateAssetDependencies(candidate, modulePath, assetIndex);
  claimAssetOwnership(candidate.id, modulePath, owners);
  validateAssetConfig(candidate, modulePath, assetIndex);
  validateAssetSourcePaths(candidate, modulePath, assetIndex);
  return /** @type {ValidatedManifestAsset} */ (candidate);
}

/** @param {ValidatedManifestAsset & { lexicon_json?: unknown; body?: string }} asset @param {string} modulePath @param {string} root @returns {Promise<LoadedAsset>} */
/* eslint-disable no-param-reassign -- the caller passes a private copy to populate with its loaded source. */
async function loadAssetSource(asset, modulePath, root) {
  try {
    if (asset.kind === 'lexicon') {
      asset.lexicon_json = await readLexiconSource(asset, root);
      const lexiconId = /** @type {{ id?: unknown } | null} */ (asset.lexicon_json)?.id;
      if (lexiconId !== asset.id) {
        const displayedId = typeof lexiconId === 'string' ? lexiconId : JSON.stringify(lexiconId) ?? String(lexiconId);
        throw new Error(`lexicon ID ${displayedId} does not match declared asset ID ${asset.id}`);
      }
    } else {
      if (!asset.path) throw new Error('script source path is missing');
      const source = path.resolve(root, /** @type {string} */ (asset.path));
      const info = await stat(source);
      if (!info.isFile()) throw new Error('script source is not a file');
      asset.body = await readFile(source, 'utf8');
      if (!asset.body.trim()) throw new Error('script source is empty');
    }
  } catch (cause) {
    // Node filesystem and package-source operations throw Error instances; preserve their original message interpolation.
    const detail = /** @type {Error} */ (cause).message;
    const sourcePath = typeof asset.path === 'string'
      ? asset.path
      : typeof asset.packagePath === 'string' ? asset.packagePath : '(unset)';
    throw new Error(`Asset ${asset.id} in module ${modulePath}: source ${sourcePath} is missing, invalid or empty (${detail}); fix the declaration or source before installing`, { cause });
  }
  return /** @type {LoadedAsset} */ (asset);
}
/* eslint-enable no-param-reassign */

/** @param {string} modulePath @param {string} file @param {Map<string, string>} owners @returns {Promise<LoadedAsset[]>} */
async function loadModuleAssets(modulePath, file, owners) {
  const module = await readModuleManifest(modulePath, file, owners);
  /** @type {LoadedAsset[]} */
  const assets = [];
  for (const entry of module.assets) {
    const asset = { ...entry };
    assets.push(await loadAssetSource(asset, modulePath, path.dirname(file)));
  }
  return assets;
}

/**
 * Load one bundle of module manifests, resolving local sources relative to each module.
 * Validates all local assets and dependencies before admin calls; returns { assets } for applyAssets.
 * @param {string} manifestPath
 * @returns {Promise<{ assets: LoadedAsset[] }>}
 */
export async function loadAssets(manifestPath) {
  const manifest = await readBundleManifest(manifestPath);
  /** @type {LoadedAsset[]} */
  const assets = [];
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const modulePath of manifest.modules) {
    const file = path.resolve(path.dirname(manifestPath), modulePath);
    assets.push(...await loadModuleAssets(modulePath, file, owners));
  }
  orderAssets(assets);
  return { assets };
}

/** @param {string} name @returns {string} */
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required and must not be blank; set it before running the installer (see hypercerts-api/README.md)`);
  }
  return value.trim();
}

async function main() {
  const baseUrl = new URL(requiredEnv('HAPPYVIEW_BASE_URL'));
  const token = requiredEnv('HAPPYVIEW_ADMIN_TOKEN');
  const client = createAdminClient({ baseUrl, token });
  const { assets } = await loadAssets(fileURLToPath(new URL('../manifest.json', import.meta.url)));
  const result = await applyAssets(assets, client);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // main only throws Error instances; retain the CLI's existing message output.
    console.error(/** @type {Error} */ (error).message);
    process.exitCode = 1;
  }
}
