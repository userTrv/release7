# Ripen specification, v0.1

Status: draft. This document describes the model and the HTTP API implemented in `packages/server`.

## 1. Concepts

**Channel.** A level on the scale "new features first ↔ fewer bugs". Channels form an ordered list, from the earliest to the most stable. The list is configured per deployment; the default has three channels: `early`, `regular` (default), `calm`.

**Subscriber.** A user or an installation of the host app, identified by an opaque id (at most 128 characters of `[A-Za-z0-9._:-]`). The SDK generates a random UUID if the app does not supply an id. Apps should not use emails or other personal data as ids.

**Feature.** A piece of functionality behind a key (`[a-z0-9][a-z0-9._-]{0,127}`). The code of every feature ships in every build; Ripen only decides who sees it.

**Stage.** Where a feature is: `off` or the id of the most stable channel it has reached. A feature at stage `S` is enabled for `S` and every earlier channel. A feature at the last channel is enabled for everyone.

**Contract.** What a channel expects from its subscribers:

| Field | Meaning |
|---|---|
| `telemetry: true` | Joining requires explicit consent to automatic error collection |
| `pulseEveryDays: N` | A pulse is expected at least every N days |

Breaking the contract is not punished: the subscriber is moved one channel towards stable, and the session tells them why (`subscriber.demotion`).

**Pulse.** A one-tap signal from a subscriber: `ok` or `broken`, optionally about one feature.

**Report.** A written description of a problem, optionally about one feature, with an optional JSON `context`.

**Error.** An automatically captured error with a fingerprint that groups identical errors. Accepted only from subscribers who consented.

**Gate.** Rules a feature must pass before moving to the next channel.

## 2. Configuration

`ripen.config.json`:

```json
{
  "channels": [
    { "id": "early", "name": "Early", "contract": { "telemetry": true, "pulseEveryDays": 14 } },
    { "id": "regular", "name": "Regular", "default": true },
    { "id": "calm", "name": "Calm" }
  ],
  "gate": { "minDaysInChannel": 3, "minPulses": 20, "maxBrokenRatio": 0.05, "maxErrorRateRatio": 1.5 }
}
```

Rules:
- at least 2 channels, ids match `[a-z0-9][a-z0-9-]{0,63}`, `off` is reserved;
- exactly one channel has `"default": true`;
- `gate` is optional, missing fields take the defaults above. A feature can override any of them.

Removing a channel from the config moves its subscribers to the default channel on their next session.

## 3. Lifecycle of a feature

```
off ──promote──▶ early ──promote (gate)──▶ regular ──promote (gate)──▶ calm
 ▲                 │                          │                        │
 └──────rollback───┴─────────rollback─────────┴────────rollback────────┘
```

- `promote` from `off` needs no gate: the first channel is where evidence is collected.
- `promote` from any other stage evaluates the gate. If it fails, the server answers `409 gate_failed` with every check explained. `force: true` overrides it and is recorded in the history.
- `rollback` moves one stage back, or straight to a given stage, including `off` as a kill switch.
- Every move resets `stageSince` and is recorded with the actor and the gate result.

## 4. Gate

The server measures since the feature entered its current stage:

| Metric | Source |
|---|---|
| `daysInStage` | Time since `stageSince` |
| `pulsesOk`, `pulsesBroken` | Pulses about this feature or about the app in general, from channels that have the feature |
| `errorRateWith` | Errors per active subscriber in channels that have the feature |
| `errorRateWithout` | The same for channels that do not have it yet |

Checks, all of which must pass:

| Check | Passes when |
|---|---|
| `min_days` | `daysInStage >= minDaysInChannel` |
| `min_pulses` | `pulsesOk + pulsesBroken >= minPulses` |
| `broken_ratio` | `pulsesBroken / pulses <= maxBrokenRatio` (0 pulses count as 0) |
| `error_rate` | `errorRateWith / errorRateWithout <= maxErrorRateRatio`. Passes if there are no errors with the feature or no group without it; fails if errors appear only with the feature |

Every event row stores the channel the subscriber was in at that moment, so later channel changes do not rewrite history. A subscriber is "active" on a day when they opened a session or sent an event that day.

## 5. HTTP API

All requests and responses are JSON. Errors look like `{ "error": "code", "message": "explanation" }`.

### Authentication

| Scope | Header | Notes |
|---|---|---|
| Client API `/v1/client/*` | `Authorization: Bearer <client key>` | The key ships inside apps and is public by design. It only lets a caller act as some subscriber |
| Admin API `/v1/admin/*` | `Authorization: Bearer <admin token>` | Secret. For the dashboard, CLI and CI |

### Client API

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/client/session` | `{ subscriberId }` | Session: creates the subscriber if needed, applies the contract |
| `PUT /v1/client/subscribers/:id/channel` | `{ channel, consent }` | Session. `400 consent_required` for telemetry channels without consent, `404 unknown_channel` |
| `POST /v1/client/pulses` | `{ subscriberId, status: "ok" \| "broken", feature?, appVersion? }` | `204` |
| `POST /v1/client/reports` | `{ subscriberId, message, feature?, appVersion?, context? }` | `{ id }` |
| `POST /v1/client/errors` | `{ subscriberId, fingerprint, message?, appVersion? }` | `204`, silently ignored without consent |

Session:

```json
{
  "subscriber": { "id": "…", "channel": "regular", "consent": false, "demotion": null },
  "channels": [{ "id": "early", "name": "Early", "contract": { "telemetry": true, "pulseEveryDays": 14 } }],
  "features": { "new-editor": true, "search-v2": false }
}
```

Choosing a channel stores the given `consent`. Choosing a channel with `consent: false` revokes consent, after which errors are no longer accepted.

### Admin API

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/admin/channels` | | Channels with subscriber counts |
| `GET /v1/admin/features` | | Features with stage, next stage and gate rules |
| `PUT /v1/admin/features/:key` | `{ description?, gate? }` | Creates the feature at `off` or updates it. `gate: null` removes the override |
| `GET /v1/admin/features/:key/health` | | Metrics, gate result (null at `off` and at the last channel), recent reports |
| `POST /v1/admin/features/:key/promote` | `{ actor?, force? }` | `{ feature, gate }` or `409 gate_failed` with `gate`, `409 already_everywhere` |
| `POST /v1/admin/features/:key/rollback` | `{ to?, actor? }` | Feature, or `409 already_off`, `400 invalid_target` |
| `GET /v1/admin/features/:key/history` | | Moves with actor, `forced` flag and gate checks |

### Limits

- Request body: 64 KB. Report message: 4000 characters. Error message: 1000 characters.
- CORS headers are sent only for the client API and only for origins listed in `RIPEN_CORS_ORIGINS`.

## 6. Privacy

- The server runs on the adopter's infrastructure. Ripen authors receive nothing.
- No IP addresses or user agents are stored.
- Errors are stored only with consent. Report text and `context` are whatever the app sends: apps should not put personal data there.
- Ids are opaque. The SDK's generated id is random and kept in `localStorage`.
