/**
 * Ripen JavaScript SDK. Works in browsers and Node.js 18+, has no dependencies.
 *
 *   const ripen = createRipen({ url: 'https://ripen.example.com', clientKey });
 *   await ripen.start();
 *   if (ripen.isEnabled('new-editor')) { ... }
 */

export interface Channel {
  id: string;
  name: string;
  description?: string;
  default?: boolean;
  contract?: { telemetry?: boolean; pulseEveryDays?: number };
}

export interface Session {
  subscriber: {
    id: string;
    channel: string;
    consent: boolean;
    demotion: { from: string; reason: string } | null;
  };
  channels: Channel[];
  features: Record<string, boolean>;
}

/** Minimal key-value storage, compatible with window.localStorage. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RipenOptions {
  /** Base URL of the Ripen server. */
  url: string;
  /** Client key of the project. It is public by design and only grants the client API. */
  clientKey: string;
  /** A stable id for this user or installation. Generated and stored if omitted. */
  subscriberId?: string;
  /** Where to keep the generated subscriber id. Defaults to localStorage when available. */
  storage?: KeyValueStorage;
  /** Version of the host app, attached to pulses, reports and errors. */
  appVersion?: string;
  fetch?: typeof fetch;
}

export class RipenError extends Error {
  override name = 'RipenError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Listener = (session: Session) => void;

const STORAGE_KEY = 'ripen.subscriberId';

export class Ripen {
  private readonly url: string;
  private readonly options: RipenOptions;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new Set<Listener>();
  private current: Session | null = null;
  private removeErrorHandlers: (() => void) | null = null;
  readonly subscriberId: string;

  constructor(options: RipenOptions) {
    this.options = options;
    this.url = options.url.replace(/\/+$/, '');
    const fetchFn = options.fetch ?? globalThis.fetch;
    if (!fetchFn) throw new Error('fetch is not available, pass options.fetch');
    this.fetchFn = fetchFn.bind(globalThis);
    this.subscriberId = options.subscriberId ?? resolveSubscriberId(options.storage ?? defaultStorage());
  }

  /** Loads the session: the subscriber's channel and which features are enabled. */
  async start(): Promise<Session> {
    return this.setSession(await this.request<Session>('POST', '/v1/client/session', { subscriberId: this.subscriberId }));
  }

  get session(): Session | null {
    return this.current;
  }

  get channel(): Channel | null {
    const id = this.current?.subscriber.channel;
    return this.current?.channels.find((c) => c.id === id) ?? null;
  }

  get channels(): Channel[] {
    return this.current?.channels ?? [];
  }

  /** Whether a feature is enabled for this subscriber. Unknown features fall back to `fallback`. */
  isEnabled(feature: string, fallback = false): boolean {
    return this.current?.features[feature] ?? fallback;
  }

  /**
   * Switches the subscriber to another channel. Channels with telemetry in their
   * contract require `consent: true`, which the app must get from the user explicitly.
   */
  async setChannel(channelId: string, { consent = false }: { consent?: boolean } = {}): Promise<Session> {
    const path = `/v1/client/subscribers/${encodeURIComponent(this.subscriberId)}/channel`;
    return this.setSession(await this.request<Session>('PUT', path, { channel: channelId, consent }));
  }

  /** One-tap signal: everything works, or something is broken. Optionally about one feature. */
  async pulse(status: 'ok' | 'broken', { feature }: { feature?: string } = {}): Promise<void> {
    await this.request('POST', '/v1/client/pulses', { subscriberId: this.subscriberId, status, feature, appVersion: this.options.appVersion });
  }

  /** A written report. `context` is any JSON object the app wants to attach; avoid personal data. */
  async report(message: string, { feature, context }: { feature?: string; context?: Record<string, unknown> } = {}): Promise<{ id: number }> {
    return this.request('POST', '/v1/client/reports', {
      subscriberId: this.subscriberId,
      message,
      feature,
      context,
      appVersion: this.options.appVersion,
    });
  }

  /** Sends an error. The server ignores it unless the subscriber consented to telemetry. */
  async captureError(error: unknown): Promise<void> {
    if (!this.current?.subscriber.consent) return;
    const { message, fingerprint } = describeError(error);
    await this.request('POST', '/v1/client/errors', {
      subscriberId: this.subscriberId,
      fingerprint,
      message,
      appVersion: this.options.appVersion,
    });
  }

  /**
   * Reports uncaught errors in the browser while the subscriber has consent.
   * Returns a function that removes the handlers.
   */
  captureUncaughtErrors(): () => void {
    this.removeErrorHandlers?.();
    const target = globalThis as unknown as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
    if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') return () => {};
    const onError = (event: Event) => void this.captureError((event as ErrorEvent).error ?? (event as ErrorEvent).message).catch(() => {});
    const onRejection = (event: Event) => void this.captureError((event as PromiseRejectionEvent).reason).catch(() => {});
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    const remove = () => {
      target.removeEventListener!('error', onError);
      target.removeEventListener!('unhandledrejection', onRejection);
    };
    this.removeErrorHandlers = remove;
    return remove;
  }

  /** Called whenever the session changes. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setSession(session: Session): Session {
    this.current = session;
    for (const listener of this.listeners) listener(session);
    return session;
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const response = await this.fetchFn(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this.options.clientKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!response.ok) {
      throw new RipenError(response.status, data?.error ?? 'http_error', data?.message ?? `HTTP ${response.status}`);
    }
    return data as T;
  }
}

export function createRipen(options: RipenOptions): Ripen {
  return new Ripen(options);
}

function resolveSubscriberId(storage: KeyValueStorage | null): string {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage can be blocked (private mode, cookies disabled): fall through to a session-only id.
  }
  const id = globalThis.crypto.randomUUID();
  try {
    storage?.setItem(STORAGE_KEY, id);
  } catch {
    // Same as above.
  }
  return id;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Groups identical errors: the same type, message and first stack frame give the same fingerprint. */
export function describeError(error: unknown): { message: string; fingerprint: string } {
  const err = error instanceof Error ? error : null;
  const message = (err ? `${err.name}: ${err.message}` : String(error)).slice(0, 1000);
  const frame = err?.stack?.split('\n').find((line) => /^\s+at\s|@/.test(line))?.trim() ?? '';
  return { message, fingerprint: hash(`${err?.name ?? 'value'}|${err?.message ?? message}|${frame}`) };
}

function hash(input: string): string {
  // FNV-1a, 32 bit: stable and small, collisions only merge similar errors.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
