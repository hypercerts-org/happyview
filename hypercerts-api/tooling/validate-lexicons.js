import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexicons, isValidLexiconDoc } from '@atproto/lexicon';
import { readLexiconSource } from './lexicon-source.js';
import { isValidDid, isValidTid } from '@atproto/syntax';

export async function validatePackageLexicons(root = fileURLToPath(new URL('../', import.meta.url))) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const documents = await Promise.all(manifest.validationLexicons.map(async (source) => {
    const doc = await readLexiconSource(source, root);
    if (doc.id !== source.id || !isValidLexiconDoc(doc)) throw new Error(`Invalid Lexicon v1 document or ID mismatch: ${source.packagePath ?? source.path}`);
    return doc;
  }));
  const lexicons = new Lexicons(documents);
  for (const doc of documents) {
    const checkRefs = (value) => {
      if (Array.isArray(value)) value.forEach(checkRefs);
      else if (value && typeof value === 'object') {
        if (value.type === 'ref') lexicons.getDefOrThrow(value.ref);
        if (value.type === 'union') value.refs.forEach((ref) => lexicons.getDefOrThrow(ref));
        Object.values(value).forEach(checkRefs);
      }
    };
    checkRefs(doc);
  }
  return { lexicons, documents, isValidDid, isValidTid };
}
