import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '@ripen/core';
import { createRipen, RipenError } from '@ripen/sdk';
import { createRipenServer, Service, Store } from '@ripen/server';

const CLIENT_KEY = 'client-key-for-tests';
const ADMIN_TOKEN = 'admin-token-for-tests';
const DAY = 24 * 60 * 60 * 1000;

let clock = new Date('2026-10-24T10:00:00Z').getTime();
let store: Store;
let baseUrl: string;
let server: ReturnType<typeof createRipenServer>;

function advance(days: number): void {
  clock += days * DAY;
}

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function client(subscriberId: string) {
  return createRipen({ url: baseUrl, clientKey: CLIENT_KEY, subscriberId, appVersion: '1.0.0' });
}

before(async () => {
  store = new Store(':memory:');
  server = createRipenServer(new Service(DEFAULT_CONFIG, store, () => new Date(clock)), {
    clientKey: CLIENT_KEY,
    adminToken: ADMIN_TOKEN,
    corsOrigins: ['https://app.example.com'],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
});

describe('auth and validation', () => {
  it('rejects a wrong client key and a wrong admin token', async () => {
    const wrong = createRipen({ url: baseUrl, clientKey: 'nope', subscriberId: 'u1' });
    await assert.rejects(wrong.start(), (e: RipenError) => e.status === 401);
    const response = await fetch(`${baseUrl}/v1/admin/features`, { headers: { Authorization: `Bearer ${CLIENT_KEY}` } });
    assert.equal(response.status, 401);
  });

  it('validates input', async () => {
    const response = await fetch(`${baseUrl}/v1/client/pulses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ subscriberId: 'u1', status: 'meh' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'bad_request');
  });

  it('answers CORS preflight only for allowed origins on the client API', async () => {
    const ok = await fetch(`${baseUrl}/v1/client/session`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.com');
    const other = await fetch(`${baseUrl}/v1/client/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});

describe('channels and features', () => {
  beforeEach(() => {
    store.db.exec('DELETE FROM subscribers; DELETE FROM features; DELETE FROM pulses; DELETE FROM errors; DELETE FROM reports; DELETE FROM activity; DELETE FROM history;');
  });

  it('puts new subscribers into the default channel', async () => {
    const session = await client('alice').start();
    assert.equal(session.subscriber.channel, 'regular');
    assert.deepEqual(session.channels.map((c) => c.id), ['early', 'regular', 'calm']);
  });

  it('requires consent to join a telemetry channel', async () => {
    const alice = client('alice');
    await assert.rejects(alice.setChannel('early'), (e: RipenError) => e.code === 'consent_required');
    const session = await alice.setChannel('early', { consent: true });
    assert.equal(session.subscriber.channel, 'early');
    assert.equal(alice.channel?.name, 'Early');
  });

  it('enables a feature channel by channel', async () => {
    await admin('PUT', '/v1/admin/features/new-editor', { description: 'Rewritten editor', gate: { minPulses: 2, minDaysInChannel: 1 } });
    const early = client('e1');
    await early.setChannel('early', { consent: true });
    const calm = client('c1');
    await calm.setChannel('calm');

    assert.equal((await early.start()).features['new-editor'], false);

    const first = await admin('POST', '/v1/admin/features/new-editor/promote', { actor: 'ci' });
    assert.equal(first.status, 200);
    assert.equal(first.data.feature.stage, 'early');
    assert.equal(first.data.gate, null, 'leaving "off" needs no gate');

    await early.start();
    await calm.start();
    assert.equal(early.isEnabled('new-editor'), true);
    assert.equal(calm.isEnabled('new-editor'), false);
  });

  it('blocks promotion until the gate passes and explains why', async () => {
    await admin('PUT', '/v1/admin/features/search', { gate: { minPulses: 2, minDaysInChannel: 1 } });
    await admin('POST', '/v1/admin/features/search/promote');
    const e1 = client('e1');
    const e2 = client('e2');
    await e1.setChannel('early', { consent: true });
    await e2.setChannel('early', { consent: true });

    const blocked = await admin('POST', '/v1/admin/features/search/promote');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, 'gate_failed');
    assert.deepEqual(blocked.data.gate.checks.filter((c: any) => !c.pass).map((c: any) => c.id), ['min_days', 'min_pulses']);

    advance(1);
    await e1.pulse('ok', { feature: 'search' });
    await e2.pulse('ok');

    const health = await admin('GET', '/v1/admin/features/search/health');
    assert.equal(health.data.health.pulsesOk, 2);
    assert.equal(health.data.gate.pass, true);

    const promoted = await admin('POST', '/v1/admin/features/search/promote', { actor: 'ci' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.data.feature.stage, 'regular');
  });

  it('fails the gate on broken pulses and lets a human force it', async () => {
    await admin('PUT', '/v1/admin/features/sync', { gate: { minPulses: 1, minDaysInChannel: 0 } });
    await admin('POST', '/v1/admin/features/sync/promote');
    const e1 = client('e1');
    await e1.setChannel('early', { consent: true });
    await e1.pulse('broken', { feature: 'sync' });
    await e1.report('Messages do not sync after reconnect', { feature: 'sync', context: { screen: 'chat' } });

    const health = await admin('GET', '/v1/admin/features/sync/health');
    assert.equal(health.data.gate.pass, false);
    assert.equal(health.data.recentReports[0].message, 'Messages do not sync after reconnect');

    const forced = await admin('POST', '/v1/admin/features/sync/promote', { force: true, actor: 'kirill' });
    assert.equal(forced.status, 200);
    const history = await admin('GET', '/v1/admin/features/sync/history');
    assert.equal(history.data.at(-1).forced, true);
  });

  it('compares error rates of subscribers with and without the feature', async () => {
    await admin('PUT', '/v1/admin/features/pay', { gate: { minPulses: 0, minDaysInChannel: 0 } });
    await admin('POST', '/v1/admin/features/pay/promote');
    const e1 = client('e1');
    await e1.setChannel('early', { consent: true });
    const r1 = client('r1');
    await r1.start();

    await e1.captureError(new TypeError('cannot read properties of undefined'));
    const health = await admin('GET', '/v1/admin/features/pay/health');
    assert.equal(health.data.health.errorRateWith, 1);
    assert.equal(health.data.health.errorRateWithout, 0);
    assert.equal(health.data.gate.pass, false);
  });

  it('ignores errors from subscribers without consent', async () => {
    await admin('PUT', '/v1/admin/features/pay', {});
    await admin('POST', '/v1/admin/features/pay/promote');
    const response = await fetch(`${baseUrl}/v1/client/errors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ subscriberId: 'r1', fingerprint: 'abc' }),
    });
    assert.equal(response.status, 204);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM errors').get() as { n: number }).n, 0);
  });

  it('rolls a feature back, including straight to off', async () => {
    await admin('PUT', '/v1/admin/features/beta', { gate: { minPulses: 0, minDaysInChannel: 0 } });
    await admin('POST', '/v1/admin/features/beta/promote');
    await admin('POST', '/v1/admin/features/beta/promote');
    const back = await admin('POST', '/v1/admin/features/beta/rollback');
    assert.equal(back.data.stage, 'early');
    const off = await admin('POST', '/v1/admin/features/beta/rollback', { to: 'off' });
    assert.equal(off.data.stage, 'off');
    const again = await admin('POST', '/v1/admin/features/beta/rollback');
    assert.equal(again.status, 409);
  });

  it('moves an inactive early subscriber down and tells them why', async () => {
    const e1 = client('e1');
    await e1.setChannel('early', { consent: true });
    advance(15);
    const session = await e1.start();
    assert.equal(session.subscriber.channel, 'regular');
    assert.equal(session.subscriber.demotion?.from, 'early');
    assert.match(session.subscriber.demotion?.reason ?? '', /no pulse in 14 days/);
  });

  it('keeps an early subscriber who sends pulses', async () => {
    const e1 = client('e1');
    await e1.setChannel('early', { consent: true });
    advance(10);
    await e1.pulse('ok');
    advance(10);
    assert.equal((await e1.start()).subscriber.channel, 'early');
  });

  it('counts subscribers per channel', async () => {
    await client('a').start();
    await client('b').setChannel('calm');
    const stats = await admin('GET', '/v1/admin/channels');
    assert.deepEqual(stats.data.map((c: any) => [c.id, c.subscribers]), [['early', 0], ['regular', 1], ['calm', 1]]);
  });
});
