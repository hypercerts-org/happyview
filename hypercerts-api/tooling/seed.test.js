import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locationRecords } from '../tests/fixtures/records.js';
import { badDateLocations } from '../tests/fixtures/bad-location-dates.js';
import { buildSeedInput, psqlTargetArgs } from './seed.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function withCopiedSeedModule(run) {
  const root = await mkdtemp(path.join(packageRoot, '.seed-cli-#'));
  try {
    await mkdir(path.join(root, 'tooling'), { recursive: true });
    await mkdir(path.join(root, 'tests/fixtures'), { recursive: true });
    await copyFile(new URL('./seed.js', import.meta.url), path.join(root, 'tooling/seed.js'));
    await copyFile(new URL('../tests/fixtures/records.js', import.meta.url), path.join(root, 'tests/fixtures/records.js'));
    await copyFile(new URL('../tests/fixtures/bad-location-dates.js', import.meta.url), path.join(root, 'tests/fixtures/bad-location-dates.js'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    return await run(path.join(root, 'tooling/seed.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('seed command refuses absent opt-in and any non-loopback/non-test database target', () => {
  assert.throws(() => buildSeedInput({}), /HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'production', PGHOST: 'localhost' }), /test marker/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'happyview_test', PGHOST: 'db.example.com' }), /PGHOST explicitly/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'postgres://127.0.0.1/happyview_test', PGHOST: '127.0.0.1' }), /simple database name/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'host=127.0.0.1 dbname=happyview_test', PGHOST: '127.0.0.1' }), /simple database name/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'happyview_test', PGHOST: '127.0.0.1', PGHOSTADDR: '203.0.113.1' }), /PGHOSTADDR/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'happyview_test', PGHOST: '127.0.0.1', PGSERVICE: 'production' }), /PGSERVICE/);
  assert.throws(() => buildSeedInput({ HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'happyview_test', PGHOST: '127.0.0.1', PGSERVICEFILE: '/tmp/pg_service.conf' }), /PGSERVICEFILE/);
});

test('seed SQL uses prepared parameters and only upserts fixture records', () => {
  const env = { HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES', PGDATABASE: 'happyview_test', PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'test_user' };
  const sql = buildSeedInput(env);
  assert.deepEqual(psqlTargetArgs(env), ['--host', '127.0.0.1', '--port', '5433', '--dbname', 'happyview_test', '--username', 'test_user']);
  assert.match(sql, /PREPARE happyview_location_fixture/);
  assert.match(sql, /ON CONFLICT \(uri\) DO UPDATE/);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP/i);
  assert.match(sql, /EXECUTE happyview_location_fixture/);
});

test('seed SQL E-escapes fixture backslashes and apostrophes', () => {
  const fixture = locationRecords.find(({ rkey }) => rkey === '3jzfcijpj2z2d');
  const originalName = fixture.record.name;
  try {
    fixture.record.name = "O'Brien \\\\woods";
    const sql = buildSeedInput({
      HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES',
      PGDATABASE: 'happyview_test',
      PGHOST: '127.0.0.1',
    });
    assert.ok(sql.includes("E'"));
    assert.ok(sql.includes(`\"name\":\"O''Brien ${'\\\\'.repeat(4)}woods\"`));
  } finally {
    fixture.record.name = originalName;
  }
});

const safeSeedEnv = {
  HAPPYVIEW_DISPOSABLE_TEST_TARGET: 'YES',
  PGHOST: '127.0.0.1',
  PGDATABASE: 'happyview_test',
};

async function withFakeExecutables(run) {
  const root = await mkdtemp(path.join(packageRoot, '.seed-executables-'));
  const selected = path.join(root, 'selected');
  const competing = path.join(root, 'psql');
  try {
    await writeFile(selected, '#!/bin/sh\nprintf "selected executable\\n" >&2\n', { mode: 0o700 });
    await writeFile(competing, '#!/bin/sh\nprintf "PATH executable\\n" >&2\n', { mode: 0o700 });
    return await run({ selected, competing, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('seed CLI rejects missing PSQL_PATH without running the PATH executable', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(({ root }) => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...safeSeedEnv, PATH: root },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /PSQL_PATH.*absolute/);
    assert.doesNotMatch(child.stderr, /PATH executable/);
  }));
});

test('seed CLI rejects relative PSQL_PATH without running the PATH executable', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(({ root }) => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...safeSeedEnv, PSQL_PATH: 'psql', PATH: root },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /PSQL_PATH.*absolute/);
    assert.doesNotMatch(child.stderr, /PATH executable/);
  }));
});

test('seed CLI runs only the configured executable even when PATH contains psql', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(({ selected, root }) => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...safeSeedEnv, PSQL_PATH: selected, PATH: root },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stderr, /selected executable/);
    assert.doesNotMatch(child.stderr, /PATH executable/);
  }));
});

test('seed CLI rejects a nonexistent absolute executable without PATH fallback', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(({ root }) => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...safeSeedEnv, PSQL_PATH: path.join(root, 'missing'), PATH: root },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /PSQL_PATH.*existing executable file/);
    assert.doesNotMatch(child.stderr, /PATH executable/);
  }));
});

test('seed CLI rejects an absolute path that is not executable', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(async ({ selected, root }) => {
    await chmod(selected, 0o600);
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...safeSeedEnv, PSQL_PATH: selected, PATH: root },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /PSQL_PATH.*executable/);
    assert.doesNotMatch(child.stderr, /PATH executable/);
  }));
});

test('bad-date seed input uses eight parameters only for the fourteen isolated fixtures', async () => {
  const { buildBadDateSeedInput } = await import('./seed.js');
  const sql = buildBadDateSeedInput(safeSeedEnv);
  assert.match(sql, /PREPARE happyview_location_fixture \(text, text, text, text, jsonb, text, text, text\)/);
  assert.match(sql, /\$7, \$8\) ON CONFLICT/);
  assert.equal((sql.match(/^EXECUTE happyview_location_fixture\(/gm) ?? []).length, 14);
  assert.match(sql, /bad-date-fixtures\.example/);
  assert.doesNotMatch(sql, /3jzfcijpj2z2a/);
  assert.match(sql, /, NULL, E'2025-01-02T03:04:05\.123456Z'\)/); // absent indexed_at is SQL NULL, not text 'null'
  const fixture = badDateLocations[0];
  const originalName = fixture.record.name;
  try {
    fixture.record.name = "O'Brien \\woods";
    assert.ok(buildBadDateSeedInput(safeSeedEnv).includes(`"name":"O''Brien ${'\\'.repeat(4)}woods"`));
  } finally {
    fixture.record.name = originalName;
  }
  const normal = buildSeedInput(safeSeedEnv);
  assert.match(normal, /PREPARE happyview_location_fixture \(text, text, text, text, jsonb, text, text\)/);
  assert.doesNotMatch(normal, /bad-date-fixtures\.example/);
});

test('bad-date CLI is opt-in, passes eight-parameter SQL to selected executable, and rejects unknown flags', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(async ({ selected, root }) => {
    const capture = path.join(root, 'input.sql');
    await writeFile(selected, '#!/bin/sh\n/bin/cat > "$SEED_CAPTURE"\n', { mode: 0o700 });
    const env = { ...safeSeedEnv, PSQL_PATH: selected, PATH: root, SEED_CAPTURE: capture };
    const normal = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    assert.equal(normal.status, 0, normal.stderr);
    assert.doesNotMatch(await readFile(capture, 'utf8'), /bad-date-fixtures\.example/);
    const bad = spawnSync(process.execPath, [script, '--bad-dates'], { encoding: 'utf8', env });
    assert.equal(bad.status, 0, bad.stderr);
    assert.match(await readFile(capture, 'utf8'), /bad-date-fixtures\.example/);
    const badSql = await readFile(capture, 'utf8');
    for (const args of [['--unknown'], ['--bad-dates', '--unexpected']]) {
      const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /Unknown seed option/);
      assert.equal(await readFile(capture, 'utf8'), badSql);
    }
  }));
});

test('bad-date CLI retains disposable target and absolute PSQL_PATH checks', async () => {
  await withCopiedSeedModule((script) => withFakeExecutables(({ selected, root }) => {
    for (const [env, message] of [
      [{ ...safeSeedEnv, HAPPYVIEW_DISPOSABLE_TEST_TARGET: undefined, PSQL_PATH: selected }, /HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES/],
      [{ ...safeSeedEnv, PGHOST: 'db.example.com', PSQL_PATH: selected }, /PGHOST explicitly/],
      [{ ...safeSeedEnv, PGHOSTADDR: '203.0.113.1', PSQL_PATH: selected }, /PGHOSTADDR/],
      [{ ...safeSeedEnv, PGDATABASE: 'production', PSQL_PATH: selected }, /test marker/],
      [{ ...safeSeedEnv, PSQL_PATH: 'psql', PATH: root }, /PSQL_PATH.*absolute/],
    ]) {
      const child = spawnSync(process.execPath, [script, '--bad-dates'], { encoding: 'utf8', env });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, message);
      assert.doesNotMatch(child.stderr, /selected executable|PATH executable/);
    }
  }));
});

test('seed CLI runs from a copied module path containing # and fails closed before psql', async () => {
  await withCopiedSeedModule((script) => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES/);
    assert.doesNotMatch(child.stderr, /psql failed/);
  });
});
