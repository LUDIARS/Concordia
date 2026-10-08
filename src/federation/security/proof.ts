import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { contract } from './ontime-runtime.js'; /* augur-inject:import:76c98396 */
import augurContract_a43ab78e from './proof.contract.js'; /* augur-inject:contract-predicate:bbb590ff */

export interface ProofParts {
  method: string; path: string; timestamp: number; nonce: string;
  body: string; audience: string; token: string;
}
export interface ProofInput { publicKey: string; parts: ProofParts; signature: string }
const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');
function canonical(parts: ProofParts): Buffer {
  return Buffer.from(JSON.stringify(['excubitor-cr-v1', parts.method.toUpperCase(), parts.path,
    parts.timestamp, parts.nonce, digest(parts.body), parts.audience, digest(parts.token)]), 'utf8');
}
export function verifyWorkloadProof(input: ProofInput): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return false;
  try {
    const key = createPublicKey(input.publicKey);
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, canonical(input.parts), key, Buffer.from(input.signature, 'base64url'));
  } catch { return false; /* Invalid remote keys/proofs are denials, never legacy fallback. */ }
}
// @ts-expect-error augur-inject
verifyWorkloadProof = contract(verifyWorkloadProof, { ...augurContract_a43ab78e, contractId: 'cc-security-C-22', mode: 'observe', sample: 1, where: 'src/federation/security/proof.ts:13', rule: 'contract-wrap', id: 'a43ab78e' }); /* augur-inject:contract-wrap:a43ab78e */
export function workloadProofHeaders(input: {
  privateKey: string; subject: string; audience: string; token: string;
  method: string; path: string; body: string; now: number; nonce?: string;
}): Record<string, string> {
  const key = createPrivateKey(input.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('workload_ed25519_required');
  const parts: ProofParts = { ...input, timestamp: input.now, nonce: input.nonce ?? randomBytes(16).toString('hex') };
  return {
    authorization: `Bearer ${input.token}`, 'x-excubitor-auth': 'cr-v1',
    'x-excubitor-workload': input.subject, 'x-excubitor-audience': input.audience,
    'x-excubitor-ts': String(parts.timestamp), 'x-excubitor-nonce': parts.nonce,
    'x-excubitor-signature': sign(null, canonical(parts), key).toString('base64url'),
  };
}
