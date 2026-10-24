#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, parseConfig, type RipenConfig } from '@ripen/core';
import { createRipenServer } from './http.ts';
import { Service } from './service.ts';
import { Store } from './store.ts';

/**
 * Configuration comes from environment variables, never from command-line
 * arguments, so secrets do not end up in the process list or shell history.
 */
const env = process.env;

const clientKey = requireSecret('RIPEN_CLIENT_KEY');
const adminToken = requireSecret('RIPEN_ADMIN_TOKEN');
const config = loadConfig(env['RIPEN_CONFIG'] ?? 'ripen.config.json');
const store = new Store(env['RIPEN_DB'] ?? 'ripen.db');
const service = new Service(config, store);

const server = createRipenServer(service, {
  clientKey,
  adminToken,
  corsOrigins: (env['RIPEN_CORS_ORIGINS'] ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
});

const port = Number(env['PORT'] ?? 4747);
const host = env['HOST'] ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`ripen server on http://${host}:${port}, channels: ${config.channels.map((c) => c.id).join(' → ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

function loadConfig(path: string): RipenConfig {
  if (!existsSync(path)) {
    console.log(`${path} not found, using the default channels`);
    return DEFAULT_CONFIG;
  }
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

function requireSecret(name: string): string {
  const value = env[name];
  if (!value || value.length < 16) {
    console.error(`${name} must be set to at least 16 characters`);
    process.exit(1);
  }
  return value;
}
