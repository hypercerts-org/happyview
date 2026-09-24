# Hypercerts API installer foundation

This package provides the conflict-safe HappyView admin installer and pinned Lexicon dependencies used by the location API. It does not yet include an installable manifest or Lua handlers; those are added in the dependent location API PR. Do not run `tooling/installer.js` against a target from this branch.

From this directory, install dependencies with `pnpm install --frozen-lockfile`, then run offline checks with `pnpm test:unit`. The installer reads existing assets first, refuses unexpected differences, and writes missing assets in dependency order. Installing assets requires the complete location package and an explicitly approved HappyView target.
