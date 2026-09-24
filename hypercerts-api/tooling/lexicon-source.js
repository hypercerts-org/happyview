import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const lexiconPackageRoot = path.dirname(require.resolve('@hypercerts-org/lexicon/package.json'));

export async function readLexiconSource(source, root = process.cwd()) {
  const file = source.packagePath
    ? path.join(lexiconPackageRoot, source.packagePath)
    : path.join(root, source.path);
  return JSON.parse(await readFile(file, 'utf8'));
}
