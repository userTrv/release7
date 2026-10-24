import type { GateRules } from './config.ts';

/** What the server measured for a feature since it entered its current stage. */
export interface StageHealth {
  daysInStage: number;
  pulsesOk: number;
  pulsesBroken: number;
  /** Errors per active subscriber among those who have the feature; null if nobody was active. */
  errorRateWith: number | null;
  /** Same for those who do not have the feature yet; null if there is no such group. */
  errorRateWithout: number | null;
}

export interface GateCheck {
  id: 'min_days' | 'min_pulses' | 'broken_ratio' | 'error_rate';
  pass: boolean;
  /** Human-readable explanation for dashboards and CI logs. */
  message: string;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
}

export function evaluateGate(rules: GateRules, health: StageHealth): GateResult {
  const pulses = health.pulsesOk + health.pulsesBroken;
  const brokenRatio = pulses === 0 ? 0 : health.pulsesBroken / pulses;

  const checks: GateCheck[] = [
    {
      id: 'min_days',
      pass: health.daysInStage >= rules.minDaysInChannel,
      message: `${round(health.daysInStage)} of ${rules.minDaysInChannel} days in channel`,
    },
    {
      id: 'min_pulses',
      pass: pulses >= rules.minPulses,
      message: `${pulses} of ${rules.minPulses} pulses`,
    },
    {
      id: 'broken_ratio',
      pass: brokenRatio <= rules.maxBrokenRatio,
      message: `${percent(brokenRatio)} broken pulses, limit ${percent(rules.maxBrokenRatio)}`,
    },
    errorRateCheck(rules, health),
  ];

  return { pass: checks.every((c) => c.pass), checks };
}

function errorRateCheck(rules: GateRules, health: StageHealth): GateCheck {
  const { errorRateWith: withRate, errorRateWithout: withoutRate } = health;
  if (withRate === null || withRate === 0) {
    return { id: 'error_rate', pass: true, message: 'no errors from subscribers with the feature' };
  }
  if (withoutRate === null) {
    return { id: 'error_rate', pass: true, message: 'no baseline: every channel has the feature' };
  }
  if (withoutRate === 0) {
    return {
      id: 'error_rate',
      pass: false,
      message: `${round(withRate)} errors per subscriber with the feature, none without it`,
    };
  }
  const ratio = withRate / withoutRate;
  return {
    id: 'error_rate',
    pass: ratio <= rules.maxErrorRateRatio,
    message: `error rate ×${round(ratio)} compared to subscribers without the feature, limit ×${rules.maxErrorRateRatio}`,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percent(n: number): string {
  return `${round(n * 100)}%`;
}
