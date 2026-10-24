# 3. No runtime dependencies

Date: 2026-10-24. Status: accepted.

## Context

Supply-chain attacks on npm became routine in 2025–2026. Companies are more willing to adopt infrastructure with a small dependency tree. Node.js now ships an HTTP server, `node:sqlite` and a test runner.

## Decision

- Server: `node:http` and `node:sqlite`, no frameworks or drivers.
- SDK: `fetch`, no dependencies.
- Development: TypeScript and `@types/node` only. Tests use `node:test`; sources run directly thanks to Node's type stripping.
- Packages expose a `ripen-source` export condition pointing to the TypeScript sources for development; published packages use `dist`.

## Consequences

- Node.js 22.13+ for running the server (22.18+ for development). On Node 22 `node:sqlite` prints an experimental warning; start with `--disable-warning=ExperimentalWarning`.
- Routing, validation and migrations are written by hand. They stay small on purpose.
- TypeScript syntax is limited to what Node can strip (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
