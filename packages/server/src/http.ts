import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isRecord } from '@ripen/core';
import { GateFailedError, ServiceError, type Service } from './service.ts';

export interface HttpOptions {
  /** Key embedded in apps. Public by nature, it only grants the client API. */
  clientKey: string;
  /** Secret for the dashboard, CLI and CI. */
  adminToken: string;
  /** Origins allowed to call the client API from browsers. "*" allows any. */
  corsOrigins: string[];
}

const MAX_BODY_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FEATURE_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;

type Handler = (ctx: Context) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  scope: 'public' | 'client' | 'admin';
  handler: Handler;
}

interface Context {
  params: string[];
  body: Record<string, unknown>;
  url: URL;
}

export function createRipenServer(service: Service, options: HttpOptions): Server {
  const routes = buildRoutes(service);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isClientApi = url.pathname.startsWith('/v1/client/');
    if (isClientApi) applyCors(req, res, options.corsOrigins);
    if (req.method === 'OPTIONS') return send(res, isClientApi ? 204 : 404, null);

    const match = findRoute(routes, req.method ?? 'GET', url.pathname);
    if (!match) return send(res, 404, { error: 'not_found', message: 'no such endpoint' });

    const { route, params } = match;
    if (route.scope === 'client' && !authorized(req, options.clientKey)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or wrong client key' });
    }
    if (route.scope === 'admin' && !authorized(req, options.adminToken)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or wrong admin token' });
    }

    try {
      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = await route.handler({ params, body, url });
      send(res, result === undefined ? 204 : 200, result ?? null);
    } catch (error) {
      if (error instanceof GateFailedError) {
        return send(res, error.status, { error: error.code, message: error.message, gate: error.gate });
      }
      if (error instanceof ServiceError) {
        return send(res, error.status, { error: error.code, message: error.message });
      }
      console.error(error);
      send(res, 500, { error: 'internal', message: 'internal server error' });
    }
  });
}

function buildRoutes(service: Service): Route[] {
  const route = (method: string, path: string, scope: Route['scope'], handler: Handler): Route => ({
    method,
    // ":param" segments capture one path segment.
    pattern: new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`),
    scope,
    handler,
  });

  return [
    route('GET', '/healthz', 'public', () => ({ ok: true })),

    route('POST', '/v1/client/session', 'client', ({ body }) => service.session(id(body, 'subscriberId'))),
    route('PUT', '/v1/client/subscribers/:id/channel', 'client', ({ params, body }) =>
      service.chooseChannel(pathId(params[0]), str(body, 'channel', 64), body['consent'] === true),
    ),
    route('POST', '/v1/client/pulses', 'client', ({ body }) => {
      const status = body['status'];
      if (status !== 'ok' && status !== 'broken') throw badRequest('status must be "ok" or "broken"');
      service.pulse(id(body, 'subscriberId'), status, featureKey(body), optStr(body, 'appVersion', 64));
    }),
    route('POST', '/v1/client/reports', 'client', ({ body }) => {
      const context = body['context'];
      if (context !== undefined && !isRecord(context)) throw badRequest('context must be an object');
      const reportId = service.report(id(body, 'subscriberId'), str(body, 'message', 4000), featureKey(body), optStr(body, 'appVersion', 64), context);
      return { id: reportId };
    }),
    route('POST', '/v1/client/errors', 'client', ({ body }) => {
      service.error(id(body, 'subscriberId'), str(body, 'fingerprint', 128), optStr(body, 'message', 1000), optStr(body, 'appVersion', 64));
    }),

    route('GET', '/v1/admin/channels', 'admin', () => service.channelStats()),
    route('GET', '/v1/admin/features', 'admin', () => service.listFeatures()),
    route('PUT', '/v1/admin/features/:key', 'admin', ({ params, body }) =>
      service.upsertFeature(pathKey(params[0]), optStr(body, 'description', 500) ?? undefined, body['gate']),
    ),
    route('GET', '/v1/admin/features/:key/health', 'admin', ({ params }) => service.health(pathKey(params[0]))),
    route('GET', '/v1/admin/features/:key/history', 'admin', ({ params }) => service.history(pathKey(params[0]))),
    route('POST', '/v1/admin/features/:key/promote', 'admin', ({ params, body }) =>
      service.promote(pathKey(params[0]), optStr(body, 'actor', 128), body['force'] === true),
    ),
    route('POST', '/v1/admin/features/:key/rollback', 'admin', ({ params, body }) =>
      service.rollback(pathKey(params[0]), optStr(body, 'to', 64) ?? undefined, optStr(body, 'actor', 128)),
    ),
  ];
}

function findRoute(routes: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1).map((p) => decodeURIComponent(p)) };
  }
  return null;
}

function authorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function applyCors(req: IncomingMessage, res: ServerResponse, origins: string[]): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (origins.includes('*') || origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ServiceError(413, 'too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('body must be valid JSON');
  }
  if (!isRecord(parsed)) throw badRequest('body must be a JSON object');
  return parsed;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (body === null || status === 204) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function badRequest(message: string): ServiceError {
  return new ServiceError(400, 'bad_request', message);
}

function str(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw badRequest(`${key} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

function optStr(body: Record<string, unknown>, key: string, max: number): string | null {
  return body[key] === undefined || body[key] === null ? null : str(body, key, max);
}

function id(body: Record<string, unknown>, key: string): string {
  const value = str(body, key, 128);
  if (!ID.test(value)) throw badRequest(`${key} must match ${ID}`);
  return value;
}

function featureKey(body: Record<string, unknown>): string | null {
  const value = optStr(body, 'feature', 128);
  if (value !== null && !FEATURE_KEY.test(value)) throw badRequest(`feature must match ${FEATURE_KEY}`);
  return value;
}

function pathId(value: string | undefined): string {
  if (!value || !ID.test(value)) throw badRequest(`subscriber id must match ${ID}`);
  return value;
}

function pathKey(value: string | undefined): string {
  if (!value || !FEATURE_KEY.test(value)) throw badRequest(`feature key must match ${FEATURE_KEY}`);
  return value;
}
