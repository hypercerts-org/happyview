# Hypercerts location API test kit

This bundle contains the `getLocation` / `listLocations` query Lexicons, deterministic test data, standalone Lua handlers, an admin API installer, and HTTP contract tests. Upstream location/profile/organization and transitive Lexicons are read from the exact `@hypercerts-org/lexicon` dependency (1.4.0), not copied into this repository. The handlers are implemented as Lua validation/query/hydration code over PostgreSQL's parameterized `db.raw`; their bundled source is checked in and reproducibly built from `lua/shared/location.lua` and `lua/src/*.lua`. On an existing disposable same-runtime image, 41 offline tests and 17 HTTP contracts passed independently. This does not establish compatibility with other HappyView versions; year-10000/BC timestamps and the existing null `indexedAt` mismatch remain deferred.

## Compatibility and current status

- Current target HappyView source revision: `a2f347e605d7cd9c11669b320e43c10dbfe982e3` (`v2.15.0`). The disposable same-runtime run is not a declared minimum supported version.
- PostgreSQL only. The fixtures write directly to `happyview_records`; this bypasses normal ingestion and record-reference synchronization. It tests the read path only. Fixture CIDs are computed from stored record JSON with `@atcute/cbor` and `@atcute/cid`. If you previously seeded these fixtures, rerun the guarded seed command on the disposable test database before comparing CIDs: the blob-backed fixture's CID changed because the previous `jsonToLex` conversion added a field absent from stored JSON.
- Contract tests exercise actual HTTP requests to a supplied running HappyView instance. They are intentionally separate from unit tests; the existing disposable same-runtime run passed 17 HTTP contracts with normal and bad-date fixtures.
- HappyView beta Lua failures currently appear as HTTP 500 `script_error`; intended domain error codes are declared separately and are not promised by the beta runtime. Host URL decoding currently mishandles `+` for spaces; requests in this kit use `%20`. URL-size limits have not been measured.
- Both endpoints are public, non-personalized reads; no auth gate or caller-specific behavior is used. The manifest records this choice.
- Keep this disposable test database separate from any persistent real-data environment. Historical location/profile/organization data may later be loaded in a separate, explicit backfill operation; this kit never backfills.

## Unit checks (offline)

Build the checked-in standalone scripts from their shared and endpoint sources with `pnpm build:lua`. The build is deterministic and uses no runtime `require`; the installer installs only `lua/endpoints/*.lua`.

From `hypercerts-api/`:

```sh
pnpm install --frozen-lockfile
pnpm build:lua
pnpm test:unit
```

The offline tests cover package/build reproducibility, install preflight, fixture and schema validation, and test tooling. No standalone Lua/LuaJIT interpreter is available in this environment, so they do not execute handler behavior or validate PostgreSQL SQL. The HTTP contract tests below remain the behavioral verification path; the existing disposable same-runtime run passed, but these commands require your own approved disposable target. The package declares exact Lexicon/CID validator dependencies; the unit suite requires those dependencies to be installed first. `manifest.json` distinguishes local schemas (`path`) from upstream package schemas (`packagePath`); both validation and installation resolve upstream files through normal Node package resolution. The offline validator checks Lexicon language/references and validates fixture records, including malformed-record rejection. The installed XRPC output validator cannot traverse record refs; this kit does not weaken schemas to work around that, so full response-view validation remains pending validator support.

## Installer bundle

The root `manifest.json` lists module manifests, each of which declares an `assets` array. Assets have an `id`, `kind` (`lexicon` or `script`), `config`, and optional `dependsOn` asset IDs. Lexicons point to a `packagePath` in `@hypercerts-org/lexicon` or a local `path`; scripts use a local `path`. Local paths are relative to the module manifest that declares them. Declare shared assets in one module and reference their IDs from dependent modules. The installer rejects duplicate IDs, missing dependencies, cycles, and invalid source files before making admin requests.

## Install (requires an explicitly approved target)

Build first, then use the existing HappyView signed admin session cookie; the installer does not mint credentials or implement OAuth:

```sh
HAPPYVIEW_BASE_URL=http://127.0.0.1:8000 \
HAPPYVIEW_SESSION_COOKIE='session-cookie-name=existing-signed-value' \
node tooling/installer.js
```

Use an account/session with existing Lexicon-create and script-manage permissions. Remote HappyView targets must use HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]`. URL credentials and non-HTTP(S) schemes are rejected, and admin requests do not follow redirects. The installer reads all required upstream record/profile/organization and transitive Lexicons from the pinned package and registers them with `backfill: false` as one deterministic source-schema group before the query Lexicons and scripts. It reads each installed asset first, compares Lexicon JSON and admin configuration with object key order ignored, compares Lua source bytes exactly, skips unchanged assets, and refuses any unexpected difference. It installs in declared dependency order and prints the exact completed/remaining IDs if a later write fails. HappyView does not provide compare-and-swap, so another writer can race between inspection and update. Do not resolve a reported conflict by blindly overwriting it.

The installer preflights all assets before making writes. For a new target, verify these exact scripts after installing them on an approved disposable PostgreSQL-backed HappyView instance.

## Disposable target: seed and run HTTP contracts

After building and installing the handlers above on an approved disposable PostgreSQL-backed HappyView target, confirm the database is disposable and the installed instance points to **that same database**. From `hypercerts-api/`, seed normal fixtures first; optionally seed the intentionally invalid-date fixtures separately before the dedicated contracts:

```sh
export HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES
export PSQL_PATH=/absolute/path/to/trusted/psql
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=happyview_test PGUSER=happyview PGPASSWORD='...'
pnpm seed:test
# Optional: only for bad-date contract verification on this disposable target
pnpm seed:bad-dates
export HAPPYVIEW_BASE_URL=http://127.0.0.1:8000
pnpm test:contracts
# Only after pnpm seed:bad-dates
pnpm test:bad-dates
```

`seed:test` remains normal-only; `seed:bad-dates` requires the explicit flag and upserts only the 14 isolated bad-date fixtures (including valid date controls). Both commands use `PREPARE`/`EXECUTE` with escaped parameters and never truncate or delete records. The target must be loopback, and `PGDATABASE` must be a simple name containing a `test` marker. `PSQL_PATH` must be an existing trusted executable at an absolute path; relative paths and `PATH` lookup are rejected. The seeder passes host, port, and database separately and rejects `PGHOSTADDR`, `PGSERVICE`, and `PGSERVICEFILE`. Unknown CLI options are rejected. Never use the optional fixtures against a persistent real-data environment.

These contracts make real HTTP GETs to both XRPC methods, not mocked-router calls. The normal suite checks record metadata, hydration, filters, pagination, validation, and error behavior. The optional suite checks malformed-date fallback and gap-free ordering; it requires the bad-date seed on the same installed target. Neither suite is part of `pnpm test:unit`, and neither command was run as part of this tooling change.
