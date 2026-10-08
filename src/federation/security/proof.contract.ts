import { createPublicKey, verify, createHash } from 'node:crypto';
import type { ProofObservation } from './contract-inputs.js';
export default { post(result: boolean, input: ProofObservation): boolean {
  if (!result) return true;
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const p = input.parts;
  try {
    const key = createPublicKey(input.publicKey);
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify([
      'excubitor-cr-v1', p.method.toUpperCase(), p.path, p.timestamp, p.nonce,
      digest(p.body), p.audience, digest(p.token),
    ]), 'utf8'), key, Buffer.from(input.signature, 'base64url'));
  } catch { return false; }
} };
