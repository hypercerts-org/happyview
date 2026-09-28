import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLuaBundles, checkLuaBundles } from './lua-bundles.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  const [option, ...extraOptions] = process.argv.slice(2);
  if (extraOptions.length > 0 || (option && option !== '--check')) {
    throw new Error('Usage: node tooling/build-lua.js [--check]');
  }

  if (option === '--check') {
    const stale = await checkLuaBundles(root);
    if (stale.length > 0) {
      const staleFiles = stale.map((file) => `  - ${file}`).join('\n');
      throw new Error(`Generated Lua bundles are stale:\n${staleFiles}\nRun \`pnpm build:lua\` to regenerate and commit them.`);
    }
    process.stdout.write('Generated Lua bundles are up to date.\n');
    return;
  }

  await buildLuaBundles(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
