import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedSql, locationRecords, profileRecords, organizationRecords } from '../tests/fixtures/records.js';
import { makeDateCaseRows, badDateSeedSql } from '../tests/fixtures/bad-dates.js';

export const badDateLocations = await makeDateCaseRows(locationRecords[0], {
  did: 'did:plc:baddatefixturesexamplexx',
  decorateRecord: (record, rkey) => ({
    ...record, locationType: 'date-test', name: `Date test ${rkey}`, description: 'Synthetic timestamp fixture',
  }),
});

function disposableTarget(env) {
  if (env.HAPPYVIEW_DISPOSABLE_TEST_TARGET !== 'YES') throw new Error('Set HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES only after confirming this is a disposable test database');
  if (env.PGHOSTADDR || env.PGSERVICE || env.PGSERVICEFILE) throw new Error('PGHOSTADDR, PGSERVICE, and PGSERVICEFILE are not allowed; they can override the loopback seed target');
  if (!env.PGDATABASE || !/^\w[\w-]*$/.test(env.PGDATABASE) || !/(^|[_-])test([_-]|$)/i.test(env.PGDATABASE)) {
    throw new Error('PGDATABASE must be a simple database name containing a test marker (for example happyview_test), not a URI or conninfo string');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(env.PGHOST)) throw new Error('Set PGHOST explicitly to localhost, 127.0.0.1, or ::1');
  const port = env.PGPORT === undefined ? 5432 : Number(env.PGPORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PGPORT must be an integer from 1 to 65535');
  return { host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER };
}

function quote(value) {
  if (value === null) return 'NULL';
  const escapedBackslash = String.raw`\\`;
  return `E'${String(value).replaceAll('\\', escapedBackslash).replaceAll("'", "''")}'`;
}

function sqlInput(statements, types = 'text, text, text, text, jsonb, text, text') {
  return [
    String.raw`\set ON_ERROR_STOP on`,
    `PREPARE happyview_fixture (${types}) AS ${statements[0].sql};`,
    ...statements.map(({ params }) => `EXECUTE happyview_fixture(${params.map(quote).join(', ')});`),
    'DEALLOCATE happyview_fixture;',
  ].join('\n');
}

export function buildSeedInput(env = process.env, rows = [...locationRecords, ...profileRecords, ...organizationRecords]) {
  disposableTarget(env);
  return sqlInput(seedSql(rows, { disposableTestTarget: true }));
}

export function buildBadDateSeedInput(env = process.env, rows = badDateLocations) {
  disposableTarget(env);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Seeding requires at least one fixture row; supply a nonempty rows array');
  return sqlInput(badDateSeedSql(rows, { disposableTestTarget: true }), 'text, text, text, text, jsonb, text, text, text');
}

function configuredPsqlPath(env) {
  const executable = env.PSQL_PATH;
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error('Set PSQL_PATH to the absolute path of a trusted psql executable; PATH lookup is not allowed');
  }
  try {
    if (!statSync(executable).isFile()) throw new Error('not a regular file');
    accessSync(executable, constants.X_OK);
  } catch (error) {
    throw new Error(`PSQL_PATH must point to an existing executable file (${executable}): ${error.message}`, { cause: error });
  }
  return executable;
}

export function psqlTargetArgs(env = process.env) {
  const target = disposableTarget(env);
  const args = ['--host', target.host, '--port', String(target.port), '--dbname', target.database];
  if (target.user) args.push('--username', target.user);
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = process.argv.slice(2);
    if (options.length > 1 || (options.length === 1 && options[0] !== '--bad-dates')) {
      throw new Error(`Unknown seed option: ${options.join(' ')}; use --bad-dates only to seed invalid-date fixtures`);
    }
    const input = options.length === 1 ? buildBadDateSeedInput() : buildSeedInput();
    const args = ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', ...psqlTargetArgs()];
    const executable = configuredPsqlPath(process.env);
    const env = { ...process.env };
    delete env.PGHOSTADDR;
    delete env.PGSERVICE;
    delete env.PGSERVICEFILE;
    const result = spawnSync(executable, args, { input, encoding: 'utf8', env, stdio: ['pipe', 'inherit', 'inherit'], shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`psql failed with exit status ${result.status}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
