import { z } from 'zod';
import { workloadCredential, type WorkloadSecurityConfig } from './config.js';
import { WorkloadTokenInactiveError } from './authority-errors.js';

/** Online per-operation revocation check; no redirects, cached permission or project token fallback. */
async function callAuthority(config: WorkloadSecurityConfig, endpoint: string, payload: Record<string, string>): Promise<unknown> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('authority_https_required');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...payload, client_id: workloadCredential(config.local.clientIdEnv),
      client_secret: workloadCredential(config.local.clientSecretEnv) }),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('authority_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 128 * 1024) throw new Error('authority_response_too_large');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export async function introspectWorkload(config: WorkloadSecurityConfig, token: string): Promise<unknown> {
  const raw = await callAuthority(config, config.authority.introspectionUrl, { token, audience: config.local.subject });
  if (z.object({ active: z.literal(false) }).safeParse(raw).success) throw new WorkloadTokenInactiveError();
  const response = z.object({ active: z.literal(true), claims: z.unknown() }).strict().parse(raw);
  return response.claims;
}
export async function issueWorkloadToken(config: WorkloadSecurityConfig, audience: string, action: string, resource: string): Promise<string> {
  return z.object({ access_token: z.string().min(1).max(32_768) }).strict().parse(
    await callAuthority(config, config.authority.tokenUrl, { audience, action, resource }),
  ).access_token;
}
