import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_GATE,
  assertCanJoin,
  checkContract,
  evaluateGate,
  isEnabled,
  nextStage,
  parseConfig,
  previousStage,
  splitByStage,
} from '@ripen/core';

const config = DEFAULT_CONFIG;
const DAY = 24 * 60 * 60 * 1000;

describe('parseConfig', () => {
  it('accepts the default config', () => {
    assert.deepEqual(parseConfig(structuredClone(DEFAULT_CONFIG)), DEFAULT_CONFIG);
  });

  it('allows any number of channels, including seven', () => {
    const channels = Array.from({ length: 7 }, (_, i) => ({ id: `level-${i + 1}`, default: i === 6 }));
    assert.equal(parseConfig({ channels }).channels.length, 7);
  });

  it('requires exactly one default channel', () => {
    assert.throws(() => parseConfig({ channels: [{ id: 'a' }, { id: 'b' }] }), ConfigError);
    assert.throws(
      () => parseConfig({ channels: [{ id: 'a', default: true }, { id: 'b', default: true }] }),
      ConfigError,
    );
  });

  it('rejects duplicated, reserved and malformed ids', () => {
    assert.throws(() => parseConfig({ channels: [{ id: 'a', default: true }, { id: 'a' }] }), /duplicated/);
    assert.throws(() => parseConfig({ channels: [{ id: 'off', default: true }, { id: 'a' }] }), /reserved/);
    assert.throws(() => parseConfig({ channels: [{ id: 'A B', default: true }, { id: 'a' }] }), /must match/);
  });

  it('merges partial gate rules over defaults and validates ranges', () => {
    const parsed = parseConfig({ channels: config.channels, gate: { minPulses: 5 } });
    assert.deepEqual(parsed.gate, { ...DEFAULT_GATE, minPulses: 5 });
    assert.throws(() => parseConfig({ channels: config.channels, gate: { maxBrokenRatio: 2 } }), ConfigError);
  });
});

describe('stages', () => {
  it('enables a feature for its stage channel and every earlier one', () => {
    assert.equal(isEnabled(config, 'regular', 'early'), true);
    assert.equal(isEnabled(config, 'regular', 'regular'), true);
    assert.equal(isEnabled(config, 'regular', 'calm'), false);
    assert.equal(isEnabled(config, 'off', 'early'), false);
    assert.equal(isEnabled(config, 'calm', 'calm'), true);
  });

  it('moves forward and back through channels', () => {
    assert.equal(nextStage(config, 'off'), 'early');
    assert.equal(nextStage(config, 'early'), 'regular');
    assert.equal(nextStage(config, 'calm'), null);
    assert.equal(previousStage(config, 'regular'), 'early');
    assert.equal(previousStage(config, 'early'), 'off');
    assert.equal(previousStage(config, 'off'), null);
  });

  it('splits channels into those with and without the feature', () => {
    assert.deepEqual(splitByStage(config, 'early'), { with: ['early'], without: ['regular', 'calm'] });
    assert.deepEqual(splitByStage(config, 'off'), { with: [], without: ['early', 'regular', 'calm'] });
  });
});

describe('contract', () => {
  const now = new Date('2026-10-24T12:00:00Z');

  it('keeps an active early subscriber', () => {
    const state = { channel: 'early', joinedAt: new Date(now.getTime() - 30 * DAY), lastPulseAt: new Date(now.getTime() - 2 * DAY) };
    assert.deepEqual(checkContract(config, state, now), { ok: true });
  });

  it('moves an inactive early subscriber one channel down', () => {
    const state = { channel: 'early', joinedAt: new Date(now.getTime() - 30 * DAY), lastPulseAt: null };
    const result = checkContract(config, state, now);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.demoteTo, 'regular');
  });

  it('gives a fresh subscriber the full period', () => {
    const state = { channel: 'early', joinedAt: new Date(now.getTime() - 13 * DAY), lastPulseAt: null };
    assert.deepEqual(checkContract(config, state, now), { ok: true });
  });

  it('expects nothing from channels without a contract', () => {
    const state = { channel: 'calm', joinedAt: new Date(0), lastPulseAt: null };
    assert.deepEqual(checkContract(config, state, now), { ok: true });
  });

  it('requires consent for telemetry channels', () => {
    assert.throws(() => assertCanJoin(config, 'early', false), { code: 'consent_required' });
    assert.equal(assertCanJoin(config, 'early', true).id, 'early');
    assert.equal(assertCanJoin(config, 'calm', false).id, 'calm');
    assert.throws(() => assertCanJoin(config, 'nightly', true), { code: 'unknown_channel' });
  });
});

describe('evaluateGate', () => {
  const healthy = { daysInStage: 4, pulsesOk: 40, pulsesBroken: 1, errorRateWith: 0.2, errorRateWithout: 0.2 };

  it('passes a healthy feature', () => {
    assert.equal(evaluateGate(DEFAULT_GATE, healthy).pass, true);
  });

  it('explains every failed check', () => {
    const result = evaluateGate(DEFAULT_GATE, { daysInStage: 1, pulsesOk: 5, pulsesBroken: 5, errorRateWith: 1, errorRateWithout: 0.2 });
    assert.equal(result.pass, false);
    assert.deepEqual(result.checks.filter((c) => !c.pass).map((c) => c.id), ['min_days', 'min_pulses', 'broken_ratio', 'error_rate']);
  });

  it('fails when errors appear only with the feature', () => {
    const result = evaluateGate(DEFAULT_GATE, { ...healthy, errorRateWith: 0.5, errorRateWithout: 0 });
    assert.equal(result.checks.find((c) => c.id === 'error_rate')?.pass, false);
  });

  it('skips the error check without a baseline', () => {
    const result = evaluateGate(DEFAULT_GATE, { ...healthy, errorRateWith: 3, errorRateWithout: null });
    assert.equal(result.checks.find((c) => c.id === 'error_rate')?.pass, true);
  });
});
