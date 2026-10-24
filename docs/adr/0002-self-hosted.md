# 2. Self-hosted only

Date: 2026-10-24. Status: accepted.

## Context

The project is open source for a portfolio, with no revenue and no budget. Hosting other companies' user data would make the author a data operator (152-FZ, GDPR) and would cost money.

## Decision

Ripen is a server the adopter runs on their own infrastructure. There is no hosted service. The demo runs in the browser.

## Consequences

- Adopters keep their users' data and their own compliance.
- Installation must be trivial: one process, one SQLite file, environment variables.
