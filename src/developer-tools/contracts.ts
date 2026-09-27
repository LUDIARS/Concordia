import { z } from "zod";

const text = z.string().trim().min(1).max(2_000);
const reference = z.string().regex(/^actio:[A-Za-z0-9-]+$/);
export const ToolInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("readiness") }).strict(),
  z.object({ operation: z.literal("tasks_list") }).strict(),
  z.object({ operation: z.literal("task_create"), request_id: z.string().uuid(), title: text,
    body: z.string().min(1).max(20_000) }).strict(),
  z.object({ operation: z.literal("task_get"), reference }).strict(),
  z.object({ operation: z.literal("task_update"), reference,
    status: z.enum(["pending", "delegated", "done", "cancelled"]) }).strict(),
  z.object({ operation: z.literal("critical_path"), pm_project_id: text.optional() }).strict(),
  z.object({ operation: z.literal("specifications"), project_id: text.optional() }).strict(),
  z.object({ operation: z.literal("implementation_context"), task: text }).strict(),
  z.object({ operation: z.literal("impact_analysis"), task: text }).strict(),
  z.object({ operation: z.literal("tests_list") }).strict(),
  z.object({ operation: z.literal("tests_run"), bundle: z.string().regex(/^(all|pr(?::[^\r\n]+)?|(?:domain|ids):[^\r\n]+)$/),
    request_id: z.string().uuid(), approval_reference: text }).strict(),
  z.object({ operation: z.literal("test_result"), request_id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("vulnerability_check") }).strict(),
]);
export type ToolInput = z.infer<typeof ToolInput>;
export class ToolUnavailable extends Error {
  constructor(readonly reason: string, readonly nextAction: string) { super(reason); }
}
export function unavailable(reason: string, nextAction: string): never {
  throw new ToolUnavailable(reason, nextAction);
}
export function failure(error: unknown) {
  return { ok: false as const, reason: error instanceof ToolUnavailable ? error.reason : "operation_failed",
    next_action: error instanceof ToolUnavailable ? error.nextAction
      : "接続・対象登録・権限を確認してください。更新の結果が不明なら同じ対象を再取得して照合してください。" };
}
