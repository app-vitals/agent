# Test file naming and runner selection

The file suffix decides which layer a test belongs to and which runner executes it.

| Suffix | Layer | Runner |
|---|---|---|
| `*.test.ts`, `*.unit.test.ts` | Unit | `bun run test:unit` (also `bun test` / `bun run test`) |
| `*.integration.test.ts` | Integration (real Postgres) | `bun run test:integration` |
| `*.smoke.test.ts` | Smoke (in-process wire contract) | `bun run test:smoke` |
| `*.canary.test.ts` | Canary only | its own entry point (not yet defined) |
| `admin/e2e/*.e2e.ts` | E2E (Playwright) | `bunx playwright test` |

## Runner exclusion

- `bunfig.toml` is the default (unit) run. Its `pathIgnorePatterns` exclude `**/*.integration.test.ts`, `**/*.smoke.test.ts`, `**/*.canary.test.ts` and `**/admin/e2e/**`.
- `bun test` treats `pathIgnorePatterns` as absolute, so a suffix filter cannot re-include an ignored file. `test:integration` and `test:smoke` therefore pass `--config=bunfig.integration.toml` / `--config=bunfig.smoke.toml`, which ignore only the other layers, plus a suffix filter (`.integration.test.ts`, `.smoke.test.ts`; bun filters are substrings, not globs).
- Keep the three bunfig files' `preload` and shared ignores in sync.

## Coverage exclusions

`coveragePathIgnorePatterns` in `bunfig.toml` excludes `**/*.fixtures.ts`, `**/test-support/**`, `chat/src/test-fakes.ts`, `lib/admin-types.ts` (generated) and `runtime/fixtures/**`.

## Adding a test

Name the file for its layer. A new suffix needs a matching script and an ignore entry in every other layer's bunfig.
