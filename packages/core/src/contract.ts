import { channelIndex } from './channels.ts';
import type { ChannelConfig, RipenConfig } from './config.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriberState {
  channel: string;
  /** When the subscriber joined their current channel. */
  joinedAt: Date;
  lastPulseAt: Date | null;
}

export type ContractCheck =
  | { ok: true }
  | { ok: false; demoteTo: string; reason: string };

/**
 * Checks whether a subscriber keeps their channel's obligations.
 * Breaking the contract is not punished, the subscriber just moves one channel
 * towards stable, where less is expected.
 */
export function checkContract(config: RipenConfig, state: SubscriberState, now: Date): ContractCheck {
  const idx = channelIndex(config, state.channel);
  const channel = config.channels[idx];
  const below = config.channels[idx + 1];
  const days = channel?.contract?.pulseEveryDays;
  if (!channel || !below || days === undefined) return { ok: true };

  const lastActivity = Math.max(state.joinedAt.getTime(), state.lastPulseAt?.getTime() ?? 0);
  if (now.getTime() - lastActivity <= days * DAY_MS) return { ok: true };

  return {
    ok: false,
    demoteTo: below.id,
    reason: `no pulse in ${days} days, required by the "${channel.name}" channel`,
  };
}

export class ChannelChoiceError extends Error {
  override name = 'ChannelChoiceError';
  readonly code: 'unknown_channel' | 'consent_required';

  constructor(message: string, code: 'unknown_channel' | 'consent_required') {
    super(message);
    this.code = code;
  }
}

/** Validates a subscriber's own choice of channel. */
export function assertCanJoin(config: RipenConfig, channelId: string, consent: boolean): ChannelConfig {
  const channel = config.channels.find((c) => c.id === channelId);
  if (!channel) throw new ChannelChoiceError(`unknown channel "${channelId}"`, 'unknown_channel');
  if (channel.contract?.telemetry && !consent) {
    throw new ChannelChoiceError(
      `the "${channel.name}" channel requires consent to automatic error collection`,
      'consent_required',
    );
  }
  return channel;
}
