/** @implements CC-SESSION-WORK-PHASES — work stage and evidence, independent of process liveness. */
// @spec セッションの設計・開始確認・実装・調整
import { z } from "zod";

export const WORK_PHASE_KEY = "cc_work_phase";
export const WORK_PHASES = ["design", "confirmation", "implementation", "adjustment"] as const;
export type WorkPhase = typeof WORK_PHASES[number];
export const WORK_PHASE_LABELS: Record<WorkPhase | "unknown", string> = {
  design: "設計", confirmation: "確認", implementation: "実装", adjustment: "調整", unknown: "未確認",
};

export interface WorkPhaseSession {
  repo_path: string;
  branch: string | null;
  current_task: string | null;
  metadata: string | null;
}

const ScopeSchema = z.object({ repo_path: z.string(), branch: z.string().nullable(), current_task: z.string().nullable() });
const RecordSchema = z.object({
  phase: z.enum(WORK_PHASES),
  revision: z.number().int().positive(),
  design_summary: z.string().max(4000),
  reason: z.string().min(1).max(1000),
  approval_reference: z.string().min(1).max(1000).nullable(),
  updated_at: z.number().int().nonnegative(),
  scope: ScopeSchema,
}).refine((record) => record.phase === "design" || record.design_summary.trim().length > 0)
  .refine((record) => !["implementation", "adjustment"].includes(record.phase) || Boolean(record.approval_reference?.trim()));
export type WorkPhaseRecord = z.infer<typeof RecordSchema>;
export interface WorkPhaseView {
  phase: WorkPhase | "unknown";
  revision: number;
  design_summary: string;
  reason: string;
  approval_reference: string | null;
  updated_at: number | null;
}

export const WorkPhaseUpdateSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  phase: z.enum(WORK_PHASES),
  design_summary: z.string().trim().max(4000),
  reason: z.string().trim().min(1).max(1000),
  approval_reference: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type WorkPhaseUpdate = z.infer<typeof WorkPhaseUpdateSchema>;

export class WorkPhaseConflict extends Error {}
export class WorkPhaseInvalid extends Error {}

export function readWorkPhaseRecord(metadata: string | null): WorkPhaseRecord | null {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(metadata ?? "{}")?.[WORK_PHASE_KEY]);
    return parsed.success ? parsed.data : null;
  } catch { return null; /* Corrupt legacy metadata is displayed as unconfirmed, never approved. */ }
}

function sameScope(record: WorkPhaseRecord, session: WorkPhaseSession): boolean {
  return record.scope.repo_path === session.repo_path && record.scope.branch === session.branch
    && record.scope.current_task === session.current_task;
}

export function readSessionWorkPhase(session: WorkPhaseSession): WorkPhaseView {
  const record = readWorkPhaseRecord(session.metadata);
  if (!record || !sameScope(record, session)) return {
    phase: "unknown", revision: record?.revision ?? 0, design_summary: "", approval_reference: null,
    reason: record ? "作業対象が変わっています。設計と開始指示を確認してください。" : "作業段階が未記録です。設計の状態を確認してください。",
    updated_at: record?.updated_at ?? null,
  };
  const { scope: _scope, ...view } = record;
  return view;
}

/** Reporting a phase records evidence; it does not grant permission to execute tools. */
export function transitionWorkPhase(session: WorkPhaseSession, input: WorkPhaseUpdate, now: number): WorkPhaseRecord {
  const current = readSessionWorkPhase(session);
  if (input.expected_revision !== current.revision) throw new WorkPhaseConflict("work_phase_revision_conflict");
  if (input.phase !== "design" && !input.design_summary) throw new WorkPhaseInvalid("design_summary_required");
  const sameDesign = current.phase !== "unknown" && current.design_summary === input.design_summary;
  const started = sameDesign && (current.phase === "implementation" || current.phase === "adjustment");
  const needsApproval = input.phase === "implementation" || input.phase === "adjustment";
  const approval = needsApproval ? input.approval_reference ?? (started ? current.approval_reference : null) : null;
  if (needsApproval && !approval) throw new WorkPhaseInvalid("human_start_confirmation_required");
  if (input.phase === "adjustment" && !started) throw new WorkPhaseInvalid("implementation_record_required");
  return {
    phase: input.phase, revision: current.revision + 1, design_summary: input.design_summary,
    reason: input.reason, approval_reference: approval, updated_at: now,
    scope: { repo_path: session.repo_path, branch: session.branch, current_task: session.current_task },
  };
}
