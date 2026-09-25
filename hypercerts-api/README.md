# Hypercerts API for HappyView

This directory contains the tooling for building and testing a Hypercerts XRPC API on HappyView. It provides a reusable installer for HappyView admin assets (Lexicons and Lua scripts), pinned Hypercerts Lexicon dependencies, and test fixtures for checking record behavior. The installer lets API modules declare their assets together, install missing assets in dependency order, and refuse to overwrite assets that differ from what is already installed.

**Current status:** This branch contains the installer and offline test tooling, not an installable API. There is no production `manifest.json` or Lua handler bundle here yet. You can run the unit tests, but do not run `tooling/installer.js` against a HappyView target from this branch.

## Get started

From `hypercerts-api/`:

```sh
pnpm install --frozen-lockfile
pnpm test:unit
```

These checks run offline; they do not require a running HappyView instance or database. The installable API bundle and its endpoint contract tests must be supplied separately before you can install or exercise API endpoints.

## How an API bundle is installed

Once an API bundle supplies a root `manifest.json` and its referenced module manifests, the installer loads Lexicon and Lua script sources, checks dependencies and existing admin assets, and only writes missing assets. It skips unchanged assets and stops on conflicts so you can resolve them manually. An installation is not an all-or-nothing transaction: if a write fails, the installer reports what it already installed and what remains.

```mermaid
flowchart TD
    Start(["Run installer"]) --> Load

    subgraph S1["1. Load"]
        Load["Read manifests and source files"] --> Valid{"All valid?"}
    end

    subgraph S2["2. Plan"]
        Order["Sort assets by dependencies"]
    end

    subgraph S3["3. Check server"]
        Fetch["Fetch what HappyView already has"] --> Conflict{"Any installed asset<br/>differs from ours?"}
    end

    subgraph S4["4. Install"]
        Each["Take next asset"] --> Same{"Already identical?"}
        Same -- Yes --> Skip["Skip it"]
        Same -- No --> Post["Create it"]
        Post --> OK{"Worked?"}
        Skip --> More{"More assets?"}
        OK -- Yes --> More
        More -- Yes --> Each
    end

    Valid -- Yes --> Order --> Fetch
    Conflict -- No --> Each
    More -- No --> Done(["Print what changed<br/>and what didn't"])

    Valid -- No --> Stop1["Stop: fix local files"]
    Conflict -- Yes --> Stop2["Stop: resolve conflict by hand"]
    OK -- No --> Stop3["Stop: report progress<br/>(no rollback)"]

    classDef stop fill:#fde2e2,stroke:#c0392b,color:#7b1f1f
    classDef done fill:#e2f5e6,stroke:#27ae60,color:#1e5631
    class Stop1,Stop2,Stop3 stop
    class Done done
```

The root manifest lists module manifests once:

```json
{ "modules": ["modules/shared/manifest.json", "modules/location/manifest.json"] }
```

Each module manifest declares `{ "assets": [...] }`. Assets have an `id`, `kind` (`lexicon` or `script`), `config`, and optional `dependsOn` asset IDs. Lexicons point to a `packagePath` in `@hypercerts-org/lexicon` or a local `path`; scripts use a local `path`. Local paths are relative to the **module manifest that declares them**. Declare shared assets in one module and reference their IDs from dependent modules. The installer rejects duplicate IDs, missing dependencies, cycles, and invalid source files before making admin requests.

With a complete bundle and an explicitly approved HappyView target, the entry point is `node tooling/installer.js`. Set `HAPPYVIEW_BASE_URL` and `HAPPYVIEW_ADMIN_TOKEN` in the environment. The installer sends `Authorization: Bearer <token>`; session-cookie authentication is not supported. Remote targets must use HTTPS; HTTP is allowed only on `localhost`, `127.0.0.1`, or `::1`. URL credentials and HTTP redirects are rejected.

The admin API key must have `lexicons:read` and `lexicons:create` for lexicon assets. If the bundle includes scripts, it also needs `scripts:read` and `scripts:manage`. If a manifest requests backfill for a new record lexicon, `backfill:create` is additionally needed to start that job; without it, the lexicon is still uploaded but no backfill starts. Do not use the installer until the bundle includes its production manifests, handlers, and domain-specific completeness tests.

## Test fixtures (disposable databases only)

The fixture tools seed records directly into PostgreSQL, bypassing HappyView ingestion. Use them **only with a separately approved, disposable loopback test database**, never persistent data. The `seed:test` and `seed:bad-dates` scripts require `HAPPYVIEW_DISPOSABLE_TEST_TARGET=YES`, a loopback `PGHOST`, a `PGDATABASE` name containing a `test` marker, and an absolute `PSQL_PATH` to a trusted `psql` executable. Standard `PGPORT` and `PGUSER` can select the test instance and user. The normal `seed:test` command seeds location, profile, and organization examples by default; `seed:bad-dates` seeds only location examples by default. Both tools also accept supplied record rows through `buildSeedInput` and `buildBadDateSeedInput` in `tooling/seed.js`.

Fixture CIDs are computed from stored record JSON with `@atcute/cbor` and `@atcute/cid`. If you seeded an older version of the blob-backed fixture, reseed the **disposable test database** before comparing CIDs: the earlier `jsonToLex` conversion produced a different CID.
