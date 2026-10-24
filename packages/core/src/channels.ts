import type { ChannelConfig, RipenConfig } from './config.ts';

/** Where a feature currently is: "off" or the most stable channel it has reached. */
export type Stage = 'off' | string;

export const OFF: Stage = 'off';

export function channelIndex(config: RipenConfig, channelId: string): number {
  return config.channels.findIndex((c) => c.id === channelId);
}

export function hasChannel(config: RipenConfig, channelId: string): boolean {
  return channelIndex(config, channelId) !== -1;
}

export function defaultChannel(config: RipenConfig): ChannelConfig {
  // parseConfig guarantees exactly one default.
  return config.channels.find((c) => c.default) ?? config.channels[0]!;
}

export function isValidStage(config: RipenConfig, stage: string): boolean {
  return stage === OFF || hasChannel(config, stage);
}

/** A feature released to `stage` is enabled for that channel and every earlier one. */
export function isEnabled(config: RipenConfig, stage: Stage, channelId: string): boolean {
  if (stage === OFF) return false;
  const stageIdx = channelIndex(config, stage);
  const channelIdx = channelIndex(config, channelId);
  return stageIdx !== -1 && channelIdx !== -1 && channelIdx <= stageIdx;
}

/** The stage after `stage`, or null when the feature already reached every channel. */
export function nextStage(config: RipenConfig, stage: Stage): string | null {
  const next = stage === OFF ? 0 : channelIndex(config, stage) + 1;
  return config.channels[next]?.id ?? null;
}

/** The stage before `stage`: the previous channel, or "off" from the first one. */
export function previousStage(config: RipenConfig, stage: Stage): Stage | null {
  if (stage === OFF) return null;
  const idx = channelIndex(config, stage);
  return idx <= 0 ? OFF : config.channels[idx - 1]!.id;
}

/** Channels that have the feature at `stage` and the ones that do not yet. */
export function splitByStage(config: RipenConfig, stage: Stage): { with: string[]; without: string[] } {
  const ids = config.channels.map((c) => c.id);
  if (stage === OFF) return { with: [], without: ids };
  const idx = channelIndex(config, stage);
  return { with: ids.slice(0, idx + 1), without: ids.slice(idx + 1) };
}
