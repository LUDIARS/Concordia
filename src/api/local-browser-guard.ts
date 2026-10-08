import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import { localBrowserDecision } from './local-browser-policy.js';

export function localAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CONCORDIA_LOCAL_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('invalid_local_allowed_origin');
    return value;
  });
}
export function localBrowserGuard(allowedOrigins = localAllowedOrigins()): MiddlewareHandler {
  return async (c, next) => {
    const error = localBrowserDecision({ method: c.req.method, url: c.req.url, host: c.req.header('host'),
      origin: c.req.header('origin'), fetchSite: c.req.header('sec-fetch-site'),
      contentType: c.req.header('content-type'), allowedOrigins });
    if (error) return c.json({ error }, error === 'local_json_required' ? 415 : 403);
    await next();
  };
}
export function localSocketBrowserAllowed(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const host = req.headers.host;
  const protocol = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http';
  return localBrowserDecision({ method: 'GET', url: `${protocol}://${host}${req.url ?? '/'}`, host,
    origin: req.headers.origin, fetchSite: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined,
    contentType: undefined, allowedOrigins }) === null;
}
