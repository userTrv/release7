# Ripen

**Let users choose how early they get new features, and let features ripen through channels on real signals.**

Ripen is a self-hosted layer of stability channels for any app. Users pick a channel on the scale "new features first ↔ fewer bugs". Early channels give feedback in return: automatic error reports with consent and a one-tap "everything works / something broke" pulse. A feature moves to the next channel only when the previous one shows it is healthy.

- **Channels chosen by users**, not random rollout percentages. Three by default (`early`, `regular`, `calm`), any number by config.
- **A channel contract.** Early channels expect more. Whoever stops keeping it is moved towards stable, not punished.
- **Promotion gates.** Time in channel, pulses, broken ratio and error rate compared to users without the feature. Like Fedora's Bodhi, for any app.
- **No platform dependency.** Channels work at the feature level inside one build: no TestFlight, store tracks or beta programs needed.
- **Self-hosted, zero runtime dependencies.** One Node.js process and one SQLite file. Your users' data stays with you.

Status: early development, v0.1. The model and the HTTP API are described in the [specification](docs/spec.md).

## Quick start

```bash
pnpm install
export RIPEN_CLIENT_KEY="$(openssl rand -hex 24)"   # ships inside your app
export RIPEN_ADMIN_TOKEN="$(openssl rand -hex 24)"  # keep secret: CI and dashboard
pnpm dev:server                                     # http://127.0.0.1:4747
```

Without `ripen.config.json` the server uses the default three channels. Settings: `RIPEN_CONFIG`, `RIPEN_DB`, `RIPEN_CORS_ORIGINS`, `HOST`, `PORT`.

### In the app

```ts
import { createRipen } from '@ripen/sdk';

const ripen = createRipen({ url: 'https://ripen.example.com', clientKey, appVersion: '2.4.0' });
await ripen.start();

if (ripen.isEnabled('new-editor')) showNewEditor();

// The user opts into the early channel from your settings screen:
await ripen.setChannel('early', { consent: true });
ripen.captureUncaughtErrors();

// After an update, ask once:
await ripen.pulse('ok');
await ripen.report('Search returns nothing for quoted phrases', { feature: 'search-v2' });
```

### In CI or by hand

```bash
api() { curl -s -H "Authorization: Bearer $RIPEN_ADMIN_TOKEN" -H 'Content-Type: application/json' "$@"; }

api -X PUT  localhost:4747/v1/admin/features/new-editor -d '{"description":"Rewritten editor"}'
api -X POST localhost:4747/v1/admin/features/new-editor/promote     # off → early
api         localhost:4747/v1/admin/features/new-editor/health      # metrics and gate checks
api -X POST localhost:4747/v1/admin/features/new-editor/promote     # early → regular, if the gate passes
api -X POST localhost:4747/v1/admin/features/new-editor/rollback -d '{"to":"off"}'   # kill switch
```

## Packages

| Package | What it is |
|---|---|
| [`@ripen/core`](packages/core) | Domain model: channels, contract, gates. Pure TypeScript, no I/O |
| [`@ripen/server`](packages/server) | HTTP server on `node:http` and `node:sqlite` |
| [`@ripen/sdk`](packages/sdk-js) | JavaScript SDK for browsers and Node.js |

## Development

Requires Node.js 22.18+ and pnpm (the version is pinned in `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm test        # node:test, runs TypeScript directly
pnpm typecheck
pnpm build
```

Design decisions are recorded in [docs/adr](docs/adr). The background research (in Russian) is in [docs/product-options.md](docs/product-options.md) and [docs/direction.md](docs/direction.md).

## Roadmap

- [x] Spec, ADRs, core model, server, JavaScript SDK
- [ ] Web component: channel switcher, pulse and report form
- [ ] OpenFeature provider, to work alongside existing flag systems
- [ ] CLI and GitHub Action for promotion in CI
- [ ] Dashboard (Angular)
- [ ] Docker image, in-browser demo
- [ ] Flutter SDK, adapters for desktop updaters

## License

[Apache-2.0](LICENSE)
