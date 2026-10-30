# CLAUDE.md

Guidance for AI coding agents working in this repository.

## Layout

- `runtime/` (`@app-vitals/agent-runtime`): the agent process. `runtime/entrypoint-main.ts` is the container entrypoint; it runs the startup sequence and spawns `index.ts`.
- `admin/` (`@app-vitals/agent-admin`): admin API and UI. `admin/src/main.ts` is its composition root.
- `chat/` (`@app-vitals/agent-chat`, private package): the chat service (Postgres-backed Thread/Message store + scoped tokens). Imported from shipwright `chat/`; `bun run db:generate` in `chat/` creates its Prisma client. Published as the `ghcr.io/app-vitals/agent-chat` image on release (`chat/Dockerfile`, platform semver tag).
- `lib/` (`@app-vitals/agent-lib`): shared modules; each is exported from `lib/package.json`.
- `agent-types/`: agent-type definitions and their JSON schema.
- `index.ts`: the agent server composition root (`startAgent([])`).

## Commands

```bash
bun install
bun run lint            # bunx biome lint .
bun run typecheck       # tsc --noEmit
bun run check:boundary  # import-boundary gate + coding-vs-platform gate (scripts/coding-boundary-allowlist.txt may only shrink)
bun run check:config-docs  # every runtime/admin env var documented
bun run check:deps      # published packages declare every third-party import
bun test                # single file: bun test path/to/file.test.ts
```

`bun test --filter` is not a real flag; pass file paths.

Post-release consumer smoke (`.github/workflows/consumer-smoke.yml`, a reusable workflow called from `release.yml` after a non-dry-run publish, or dispatched manually with a version): `bun scripts/consumer-smoke.ts --version X.Y.Z` installs the published packages in a scratch dir and imports every `exports` entry; `--pack` uses locally packed tarballs instead (no release needed, skips the docker boot checks).

## Conventions

- Conventional Commits for commits and PR titles (squash merge; semantic-release reads the title).
- Tests land with the code: `*.unit.test.ts`, `*.integration.test.ts`, `*.smoke.test.ts`.
- Imports must stay inside this repository. Use `@app-vitals/agent-runtime/*`, `@app-vitals/agent-lib/*` and `@app-vitals/agent-admin` for cross-package imports.
- The generated Prisma client (`admin/prisma/client`) is never committed; `bunx prisma generate --schema=prisma/schema` in `admin/` creates it.
- `runtime/Dockerfile` keeps the module-resolution guard (a `bun build` over every runtime source file) and the base-image contract (`/opt/shipwright/marketplaces/`, `installPlugins()`, the entrypoint path). Change them only together with `runtime/base-image-contract.smoke.test.ts`.
- Never hand-edit version fields (the release tag stamps them at publish time); releases are automated.
