# Agent instructions

## Map
- `src/`, `crates/`, `tests/`, `migrations/`: Rust server, crates, tests, and database migrations.
- `web/`: Next.js app (npm). `packages/`: Bun workspace SDKs. `scripts/`: repo tooling.
- `hypercerts-api/`: standalone pnpm toolkit for installing/testing Hypercerts XRPC assets; this foundation branch has tooling, not a complete installable API. It is not part of the root workspace.

## Checks
Run checks for the area changed:
- Rust: `cargo fmt -- --check`; `cargo clippy --workspace --all-targets -- -D warnings`; unit tests: `cargo test --lib` and `cargo test --workspace --exclude happyview`.
- DB-backed tests: `cargo test --tests` with `TEST_DATABASE_URL` set. Start local Postgres with `docker compose -f docker-compose.test.yml up -d`.
- Web: from `web/`, `npm ci && npm run build` (lint: `npm run lint`).
- SDK package: from the root, run `bun install`, then `bun run --filter '<package>' build`, `bun run --filter '<package>' typecheck`, and `bun run --filter '<package>' test`.
- Hypercerts API: from `hypercerts-api/`, `pnpm check`.
