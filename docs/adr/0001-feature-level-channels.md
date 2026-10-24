# 1. Channels at the feature level, not the build level

Date: 2026-10-24. Status: accepted.

## Context

Build-level channels (separate beta builds) depend on platform policies: TestFlight limits and its ban on rewarding testers, Google Play tracks, RuStore allowing one beta at a time. The project must not depend on Apple, Google, Microsoft or any store.

## Decision

Every subscriber runs the same build. The SDK asks the server which features are enabled for the subscriber's channel. A channel is a set of enabled features, not a binary.

## Consequences

- Works the same on the web, backend, desktop and mobile. Turning on code that already ships through remote configuration is how every feature flag system works. Ripen never downloads or runs new code.
- Bugs outside feature boundaries (a new library version, a refactoring) are not isolated by channels. Build-level channels for desktop may come later as an optional adapter.
