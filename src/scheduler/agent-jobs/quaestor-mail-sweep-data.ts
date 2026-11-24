import { contract } from '../ontime-runtime.js'; /* augur-inject:import:6823e522 */
import augurContract_9414817c from './quaestor-mail-sweep-data.contract.js'; /* augur-inject:contract-predicate:a5abc27a */
/** @implements spec/feature/parttimer-agent-dispatch.md — メール取り込みの許可リスト */
const CLASSIFICATIONS = ["invoice", "cloud_notice", "ci_failure", "dependabot", "ignore"] as const;
const ERROR_KINDS = ["auth", "rate_limit", "not_found", "network", "invalid_response"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function projectMailSweep(payload: unknown) {
  const row = record(payload);
  if (!row) return null;
  const { fetched, committed, needs_review, notified, disabled, errors } = row;
  const processed = record(row.processed);
  if (!processed || !CLASSIFICATIONS.every((key) => isCount(processed[key]))
    || !isCount(fetched) || !isCount(committed) || !isCount(needs_review) || !isCount(notified)
    || !Array.isArray(errors) || (disabled !== undefined && typeof disabled !== "boolean")) return null;
  return {
    fetched,
    processed: Object.fromEntries(CLASSIFICATIONS.map((key) => [key, processed[key]])),
    committed,
    needs_review,
    notified,
    disabled: disabled === true,
    errors: errors.map((item: unknown) => {
      const error = record(item);
      const rawKind = typeof error?.error === "string" ? error.error.replace(/^mail_/u, "") : "";
      return {
        message_id: typeof error?.message_id === "string" && /^(?:\*|[a-f0-9]{1,32})$/iu.test(error.message_id)
          ? error.message_id : "*",
        kind: ERROR_KINDS.find((kind) => kind === rawKind) ?? "processing_error",
      };
    }),
  };
}
// @ts-expect-error augur-inject
projectMailSweep = contract(projectMailSweep, { ...augurContract_9414817c, contractId: 'cron-mail-kaizen-C-41', mode: 'observe', sample: 1, where: 'src/scheduler/agent-jobs/quaestor-mail-sweep-data.ts:13', rule: 'contract-wrap', id: '9414817c' }); /* augur-inject:contract-wrap:9414817c */

export function projectReviewIds(payload: unknown): string[] | null {
  if (!Array.isArray(payload)) return null;
  return [...new Set(payload.flatMap((item: unknown) => {
    const id = record(item)?.id;
    return typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(id) ? [id] : [];
  }))];
}

type SweepFailure = "endpoint_unavailable" | "timeout" | "transport" | "http_error" | "invalid_response" | "interrupted";

export type MailSweepData =
  | (NonNullable<ReturnType<typeof projectMailSweep>> & {
    sweep_status: "completed" | "disabled";
    needs_review_ids: string[];
    needs_review_ids_unavailable?: true;
  })
  | { sweep_status: "failed" | "unknown"; failure_kind: SweepFailure; http_status?: number };
