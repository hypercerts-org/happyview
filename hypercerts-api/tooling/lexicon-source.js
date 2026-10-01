import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const lexiconPackageRoot = path.dirname(require.resolve('@hypercerts-org/lexicon/package.json'));

/** @typedef {{ packagePath?: string; path?: string }} LexiconSource */
/** @param {LexiconSource} source @param {string} [root] @returns {Promise<unknown>} */
export async function readLexiconSource(source, root = process.cwd()) {
  // path.join rejects non-string segments; these narrow assertions preserve that existing runtime check.
  const file = source.packagePath
    ? path.join(lexiconPackageRoot, /** @type {string} */ (source.packagePath))
    : path.join(root, /** @type {string} */ (source.path));
  return JSON.parse(await readFile(file, 'utf8'));
}
