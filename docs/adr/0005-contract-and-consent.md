# 5. Channel contract: demotion instead of penalties, explicit consent

Date: 2026-10-24. Status: accepted.

## Context

Earlier channels should expect more from their subscribers. Nobody can be forced to write bug reports, and collecting errors without consent is not acceptable.

## Decision

- A channel may require consent to error collection (`telemetry`) and a pulse every N days (`pulseEveryDays`).
- Joining a telemetry channel without `consent: true` is rejected. Errors from subscribers without consent are dropped by the server.
- A subscriber who breaks the contract is moved one channel towards stable and told why. There are no other penalties.
- The required contribution is cheap (one-tap pulses, automatic errors). Written reports stay optional.

## Consequences

The amount of signal depends on how many people choose early channels, not on their discipline. Demoted subscribers keep their consent until they choose a channel without it.
