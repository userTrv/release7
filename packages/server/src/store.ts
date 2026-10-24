import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite storage. Every event row keeps the channel the subscriber was in at
 * that moment, so health is computed from history rather than current state.
 */

export interface SubscriberRow {
  id: string;
  channel: string;
  consent: number;
  joined_at: number;
  last_seen_at: number;
  last_pulse_at: number | null;
  demoted_from: string | null;
  demoted_reason: string | null;
}

export interface FeatureRow {
  key: string;
  description: string;
  stage: string;
  stage_since: number;
  gate_json: string | null;
  created_at: number;
}

export interface HistoryRow {
  feature: string;
  from_stage: string;
  to_stage: string;
  action: string;
  actor: string | null;
  forced: number;
  checks_json: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  consent INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_pulse_at INTEGER,
  demoted_from TEXT,
  demoted_reason TEXT
);
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  stage_since INTEGER NOT NULL,
  gate_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  subscriber_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, day)
);
CREATE TABLE IF NOT EXISTS pulses (
  id INTEGER PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  feature TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'broken')),
  app_version TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pulses_by_time ON pulses (created_at);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  feature TEXT,
  message TEXT NOT NULL,
  app_version TEXT,
  context_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_by_time ON reports (created_at);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS errors_by_time ON errors (created_at);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  feature TEXT NOT NULL,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT,
  created_at INTEGER NOT NULL
);
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Subscribers

  getSubscriber(id: string): SubscriberRow | undefined {
    return this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id) as SubscriberRow | undefined;
  }

  insertSubscriber(row: SubscriberRow): void {
    this.db
      .prepare(
        `INSERT INTO subscribers (id, channel, consent, joined_at, last_seen_at, last_pulse_at, demoted_from, demoted_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.channel, row.consent, row.joined_at, row.last_seen_at, row.last_pulse_at, row.demoted_from, row.demoted_reason);
  }

  updateSubscriber(row: SubscriberRow): void {
    this.db
      .prepare(
        `UPDATE subscribers SET channel = ?, consent = ?, joined_at = ?, last_seen_at = ?, last_pulse_at = ?,
         demoted_from = ?, demoted_reason = ? WHERE id = ?`,
      )
      .run(row.channel, row.consent, row.joined_at, row.last_seen_at, row.last_pulse_at, row.demoted_from, row.demoted_reason, row.id);
  }

  /** Records that a subscriber was active today in a channel (one row per day). */
  touchActivity(subscriberId: string, channel: string, at: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO activity (subscriber_id, channel, day) VALUES (?, ?, ?)')
      .run(subscriberId, channel, Math.floor(at / DAY_MS));
  }

  countSubscribersByChannel(): Record<string, number> {
    const rows = this.db.prepare('SELECT channel, COUNT(*) AS n FROM subscribers GROUP BY channel').all() as {
      channel: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.channel, r.n]));
  }

  // Features

  listFeatures(): FeatureRow[] {
    return this.db.prepare('SELECT * FROM features ORDER BY key').all() as unknown as FeatureRow[];
  }

  getFeature(key: string): FeatureRow | undefined {
    return this.db.prepare('SELECT * FROM features WHERE key = ?').get(key) as FeatureRow | undefined;
  }

  insertFeature(row: FeatureRow): void {
    this.db
      .prepare('INSERT INTO features (key, description, stage, stage_since, gate_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.key, row.description, row.stage, row.stage_since, row.gate_json, row.created_at);
  }

  updateFeature(row: FeatureRow): void {
    this.db
      .prepare('UPDATE features SET description = ?, stage = ?, stage_since = ?, gate_json = ? WHERE key = ?')
      .run(row.description, row.stage, row.stage_since, row.gate_json, row.key);
  }

  addHistory(row: HistoryRow): void {
    this.db
      .prepare(
        `INSERT INTO history (feature, from_stage, to_stage, action, actor, forced, checks_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.feature, row.from_stage, row.to_stage, row.action, row.actor, row.forced, row.checks_json, row.created_at);
  }

  history(feature: string): HistoryRow[] {
    return this.db
      .prepare('SELECT feature, from_stage, to_stage, action, actor, forced, checks_json, created_at FROM history WHERE feature = ? ORDER BY id')
      .all(feature) as unknown as HistoryRow[];
  }

  // Events

  addPulse(subscriberId: string, channel: string, feature: string | null, status: 'ok' | 'broken', appVersion: string | null, at: number): void {
    this.db
      .prepare('INSERT INTO pulses (subscriber_id, channel, feature, status, app_version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(subscriberId, channel, feature, status, appVersion, at);
  }

  addReport(subscriberId: string, channel: string, feature: string | null, message: string, appVersion: string | null, contextJson: string | null, at: number): number {
    const result = this.db
      .prepare('INSERT INTO reports (subscriber_id, channel, feature, message, app_version, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(subscriberId, channel, feature, message, appVersion, contextJson, at);
    return Number(result.lastInsertRowid);
  }

  addError(subscriberId: string, channel: string, fingerprint: string, message: string | null, appVersion: string | null, at: number): void {
    this.db
      .prepare('INSERT INTO errors (subscriber_id, channel, fingerprint, message, app_version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(subscriberId, channel, fingerprint, message, appVersion, at);
  }

  /** Pulses about the feature or about the app in general, from the given channels since `since`. */
  countPulses(channels: string[], feature: string, since: number): { ok: number; broken: number } {
    if (channels.length === 0) return { ok: 0, broken: 0 };
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(status = 'ok'), 0) AS ok, COALESCE(SUM(status = 'broken'), 0) AS broken FROM pulses
         WHERE created_at >= ? AND (feature IS NULL OR feature = ?) AND channel IN (${placeholders(channels)})`,
      )
      .get(since, feature, ...channels) as { ok: number; broken: number };
    return { ok: Number(row.ok), broken: Number(row.broken) };
  }

  /** Errors per active subscriber in the given channels since `since`, or null if nobody was active. */
  errorRate(channels: string[], since: number): number | null {
    if (channels.length === 0) return null;
    const ph = placeholders(channels);
    const active = this.db
      .prepare(`SELECT COUNT(DISTINCT subscriber_id) AS n FROM activity WHERE day >= ? AND channel IN (${ph})`)
      .get(Math.floor(since / DAY_MS), ...channels) as { n: number };
    if (Number(active.n) === 0) return null;
    const errors = this.db
      .prepare(`SELECT COUNT(*) AS n FROM errors WHERE created_at >= ? AND channel IN (${ph})`)
      .get(since, ...channels) as { n: number };
    return Number(errors.n) / Number(active.n);
  }

  recentReports(channels: string[], feature: string, since: number, limit = 20): ReportView[] {
    if (channels.length === 0) return [];
    return this.db
      .prepare(
        `SELECT id, channel, feature, message, app_version, created_at FROM reports
         WHERE created_at >= ? AND (feature IS NULL OR feature = ?) AND channel IN (${placeholders(channels)})
         ORDER BY id DESC LIMIT ?`,
      )
      .all(since, feature, ...channels, limit) as unknown as ReportView[];
  }
}

export interface ReportView {
  id: number;
  channel: string;
  feature: string | null;
  message: string;
  app_version: string | null;
  created_at: number;
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}
