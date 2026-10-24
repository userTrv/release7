/**
 * Ripen configuration: the ordered list of channels and default gate rules.
 *
 * Channels are ordered from the earliest (most new features, most risk) to the
 * most stable. A feature released to channel N is enabled for channels 0..N.
 */

export interface ChannelContract {
  /** Joining requires explicit consent to automatic error collection. */
  telemetry?: boolean;
  /**
   * A subscriber must send a pulse at least this often. Otherwise they are
   * moved one channel down (towards stable). Omitted means no obligation.
   */
  pulseEveryDays?: number;
}

export interface ChannelConfig {
  id: string;
  name: string;
  description?: string;
  /** New subscribers land here. Exactly one channel must be the default. */
  default?: boolean;
  contract?: ChannelContract;
}

export interface GateRules {
  /** Minimum time a feature spends in a channel before it can move on. */
  minDaysInChannel: number;
  /** Minimum number of pulses from subscribers who have the feature. */
  minPulses: number;
  /** Maximum share of "broken" pulses, 0..1. */
  maxBrokenRatio: number;
  /**
   * Maximum error rate of subscribers with the feature relative to those
   * without it. 1.5 means "at most 50% more errors per active subscriber".
   */
  maxErrorRateRatio: number;
}

export interface RipenConfig {
  channels: ChannelConfig[];
  gate: GateRules;
}

export const DEFAULT_GATE: GateRules = {
  minDaysInChannel: 3,
  minPulses: 20,
  maxBrokenRatio: 0.05,
  maxErrorRateRatio: 1.5,
};

export const DEFAULT_CONFIG: RipenConfig = {
  channels: [
    {
      id: 'early',
      name: 'Early',
      description: 'New features first. Errors are collected automatically, a one-tap pulse is expected every two weeks.',
      contract: { telemetry: true, pulseEveryDays: 14 },
    },
    {
      id: 'regular',
      name: 'Regular',
      description: 'Features that early subscribers found no serious problems with.',
      default: true,
    },
    {
      id: 'calm',
      name: 'Calm',
      description: 'Only features that have proven themselves. Nothing is expected from you.',
    },
  ],
  gate: DEFAULT_GATE,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates an untrusted config object (e.g. parsed JSON) and fills in defaults. */
export function parseConfig(input: unknown): RipenConfig {
  if (!isRecord(input)) throw new ConfigError('config must be an object');
  const rawChannels = input['channels'];
  if (!Array.isArray(rawChannels) || rawChannels.length < 2) {
    throw new ConfigError('config.channels must list at least 2 channels');
  }

  const seen = new Set<string>();
  const channels = rawChannels.map((raw, i): ChannelConfig => {
    const at = `config.channels[${i}]`;
    if (!isRecord(raw)) throw new ConfigError(`${at} must be an object`);
    const id = raw['id'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ConfigError(`${at}.id must match ${ID_PATTERN}`);
    }
    if (id === 'off') throw new ConfigError(`${at}.id "off" is reserved`);
    if (seen.has(id)) throw new ConfigError(`${at}.id "${id}" is duplicated`);
    seen.add(id);

    const channel: ChannelConfig = { id, name: optionalString(raw, 'name', at) ?? id };
    const description = optionalString(raw, 'description', at);
    if (description !== undefined) channel.description = description;
    if (raw['default'] === true) channel.default = true;
    const contract = raw['contract'];
    if (contract !== undefined) channel.contract = parseContract(contract, `${at}.contract`);
    return channel;
  });

  const defaults = channels.filter((c) => c.default);
  if (defaults.length !== 1) {
    throw new ConfigError('exactly one channel must have "default": true');
  }

  return { channels, gate: parseGate(input['gate'], 'config.gate', DEFAULT_GATE) };
}

/** Parses partial gate rules on top of a base, e.g. a per-feature override. */
export function parseGate(input: unknown, at: string, base: GateRules): GateRules {
  if (input === undefined) return { ...base };
  if (!isRecord(input)) throw new ConfigError(`${at} must be an object`);
  return {
    minDaysInChannel: number(input, 'minDaysInChannel', at, base.minDaysInChannel, 0),
    minPulses: number(input, 'minPulses', at, base.minPulses, 0),
    maxBrokenRatio: number(input, 'maxBrokenRatio', at, base.maxBrokenRatio, 0, 1),
    maxErrorRateRatio: number(input, 'maxErrorRateRatio', at, base.maxErrorRateRatio, 1),
  };
}

function parseContract(input: unknown, at: string): ChannelContract {
  if (!isRecord(input)) throw new ConfigError(`${at} must be an object`);
  const contract: ChannelContract = {};
  if (input['telemetry'] !== undefined) {
    if (typeof input['telemetry'] !== 'boolean') throw new ConfigError(`${at}.telemetry must be a boolean`);
    contract.telemetry = input['telemetry'];
  }
  if (input['pulseEveryDays'] !== undefined) {
    contract.pulseEveryDays = number(input, 'pulseEveryDays', at, 0, 1);
  }
  return contract;
}

function number(obj: Record<string, unknown>, key: string, at: string, fallback: number, min: number, max = Infinity): number {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${at}.${key} must be a number in [${min}, ${max}]`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new ConfigError(`${at}.${key} must be a string`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
