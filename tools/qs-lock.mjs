import { isDeepStrictEqual } from "node:util";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:33c8315e */
import augurContract_7cf39512 from './qs-lock.contract.mjs'; /* augur-inject:contract-predicate:e7be8c28 */

/** Validate the one allowed lockfile update without changing either snapshot. */
export function verifyQsLockUpdate(before, after) {
  const key = "node_modules/qs";
  const previous = before.packages?.[key];
  if (previous?.version !== "6.16.0") return false;
  const expected = structuredClone(before);
  expected.packages[key] = {
    ...previous,
    version: "6.16.2",
    resolved: "https://registry.npmjs.org/qs/-/qs-6.16.2.tgz",
    integrity: "sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA==",
  };
  return isDeepStrictEqual(expected, after);
}
// @ts-expect-error augur-inject
verifyQsLockUpdate = contract(verifyQsLockUpdate, { ...augurContract_7cf39512, contractId: 'qs-lock-C-1', mode: 'observe', sample: 1, where: 'tools/qs-lock.mjs:4', rule: 'contract-wrap', id: '7cf39512' }); /* augur-inject:contract-wrap:7cf39512 */
