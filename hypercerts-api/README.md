# Hypercerts API installer foundation

This package provides a reusable, conflict-safe HappyView admin installer, pinned Lexicon dependencies, and guarded test seeding tools. The included location records are example fixtures, not a restriction on the tooling. It does not yet include an installable manifest or Lua handlers; those are added in the dependent location API PR. Do not run `tooling/installer.js` against a target from this branch.

Fixture CIDs are computed from stored record JSON with `@atcute/cbor` and `@atcute/cid`. If you previously seeded these fixtures, rerun the guarded seed command on the disposable test database before comparing CIDs: the blob-backed fixture's CID changed because the previous `jsonToLex` conversion added a field absent from stored JSON.

From this directory, install dependencies with `pnpm install --frozen-lockfile`, then run offline checks with `pnpm test:unit`. The default installer entry point remains `node tooling/installer.js`, but **this branch has no production `manifest.json` or Lua handlers; do not run it against a target**. The dependent API branch must supply a complete production bundle and its domain-specific completeness tests before installation on an explicitly approved HappyView target.

The production `manifest.json` should list module manifests once; this example uses a location module:

```json
{ "modules": ["modules/shared/manifest.json", "modules/location/manifest.json"] }
```

Each referenced module manifest has `{ "assets": [...] }` using the existing asset declarations (`id`, `kind`, `config`, optional `dependsOn`). Lexicons use `packagePath` (relative to `@hypercerts-org/lexicon`) or `path`; scripts use `path`. Local paths resolve relative to **the declaring module manifest**, not the bundle. Shared schemas belong to one module; other modules refer to their IDs in `dependsOn`. The installer combines all modules into one run, rejects duplicate IDs, missing dependencies and cycles, validates every script source, then reads all installed assets before writing any. Unchanged assets are skipped; conflicts require manual resolution. Domain-specific handler completeness belongs in domain tests, not the generic installer.

Seeding bypasses ingestion and is only for a separately approved, disposable loopback PostgreSQL test database; never use these fixtures on persistent data. `seedSql(rows, { disposableTestTarget: true })` from `tests/fixtures/records.js` produces SQL statements for supplied record rows. `buildSeedInput(env = process.env, rows = existing default example rows)` and `buildBadDateSeedInput(env = process.env, rows = badDateLocations)` from `tooling/seed.js` accept supplied rows while keeping the location examples as CLI defaults. Malformed `createdAt` test rows can be built for any record collection with `makeDateCaseRows(baseRecord, { did })` from `tests/fixtures/bad-dates.js`. Convert those rows to SQL with `badDateSeedSql(rows, { disposableTestTarget: true })` only for an approved disposable test target. The guarded `seed:bad-dates` command still seeds only location rows by default. See the dependent PR for the full install and contract-test procedure.
