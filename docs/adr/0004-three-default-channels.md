# 4. Three channels by default, any number by configuration

Date: 2026-10-24. Status: accepted.

## Context

The original idea had seven levels. Every channel needs enough subscribers to catch a bug: if a bug affects 1% of users and 5% of them report it, three reports take about 6000 active subscribers in that channel. Major products keep 3–5 channels; in April 2026 Microsoft merged Windows Insider channels because users were confused.

## Decision

The default config has three channels: `early`, `regular` (default), `calm`. The number is configurable, at least two.

## Consequences

Small apps get meaningful statistics per channel. Large apps can configure more channels.
