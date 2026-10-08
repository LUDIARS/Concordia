import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { InboundGrant, WorkloadId } from './claims.js';

const httpsUrl = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
}, 'authority_https_required');
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const SecurityConfig = z.object({
  local: z.object({
    subject: WorkloadId.refine(value => value.endsWith('/concordia')),
    clientIdEnv: envName, clientSecretEnv: envName, privateKeyEnv: envName,
  }).strict(),
  authority: z.object({ tokenUrl: httpsUrl, introspectionUrl: httpsUrl }).strict(),
  inbound: z.array(InboundGrant).max(1000),
  sites: z.record(WorkloadId.refine(value => value.endsWith('/concordia'))),
}).strict();
export type WorkloadSecurityConfig = z.infer<typeof SecurityConfig>;

/** Administrator file only; mutable site settings cannot add grants or trust anchors. */
export function readWorkloadSecurityConfig(env: NodeJS.ProcessEnv): WorkloadSecurityConfig | null {
  const path = env.CONCORDIA_WORKLOAD_SECURITY_FILE;
  if (!path) return null;
  const bytes = readFileSync(path);
  if (bytes.byteLength > 256 * 1024) throw new Error('workload_security_config_too_large');
  return SecurityConfig.parse(JSON.parse(bytes.toString('utf8')));
}

export function workloadCredential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('workload_credential_missing');
  return value;
}
