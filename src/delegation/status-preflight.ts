import { StatusSchema } from "./status-schema.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:732d1309 */
import augurContract_74e2d42a from './status-preflight.contract.js'; /* augur-inject:contract-predicate:e99d6055 */

export interface StatusInputIssue {
  field: string;
  code: string;
  limit?: number;
  length?: number;
}
export interface StatusPreflightResult {
  valid: boolean;
  issues: StatusInputIssue[];
}

/** @implements spec/feature/delegation.md#送信前のローカル入力検査 */
export function preflightStatusJson(text: string): StatusPreflightResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { valid: false, issues: [{ field: "$", code: "invalid_json" }] }; }
  const parsed = StatusSchema.safeParse(value);
  if (parsed.success) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: parsed.error.issues.map(issue => {
      // Paths come only from the fixed object schema; unknown input keys are stripped.
      const field = issue.path.map(part => typeof part === "number" ? `[${part}]` : `.${part}`).join("");
      const diagnostic: StatusInputIssue = { field: `$${field}`, code: issue.code };
      if (issue.code === "too_big" || issue.code === "too_small") {
        diagnostic.limit = Number(issue.code === "too_big" ? issue.maximum : issue.minimum);
        let current: unknown = value;
        for (const part of issue.path) {
          current = current !== null && typeof current === "object"
            ? (current as Record<string | number, unknown>)[part] : undefined;
        }
        if (typeof current === "string" || Array.isArray(current)) diagnostic.length = current.length;
      }
      return diagnostic;
    }),
  };
}
// @ts-expect-error augur-inject
preflightStatusJson = contract(preflightStatusJson, { ...augurContract_74e2d42a, contractId: 'status-preflight-C-20', mode: 'observe', sample: 1, where: 'src/delegation/status-preflight.ts:15', rule: 'contract-wrap', id: '74e2d42a' }); /* augur-inject:contract-wrap:74e2d42a */
