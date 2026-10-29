import { z } from "zod";

export const RemainingSchema = z.object({
  title: z.string().min(1).max(300),
  note: z.string().max(4000).optional(),
  scope_dirs: z.array(z.string().min(1).max(1000)).max(100).optional(),
  kind: z.enum(["work", "wait"]).optional(),
});
const AcceptanceReportSchema = z.object({
  criterion: z.string().min(1).max(1000),
  met: z.boolean(),
  note: z.string().max(4000).optional(),
});
/** Shared input contract; completion evidence and run transitions belong to the API. */
export const StatusSchema = z.object({
  resident_generation: z.string().min(1).max(200).optional(),
  status: z.enum(["running", "completed", "partial", "failed"]),
  detail: z.string().max(4000).optional(),
  result: z.string().max(4000).optional(),
  remaining: z.array(RemainingSchema).max(100).optional(),
  acceptance_report: z.array(AcceptanceReportSchema).max(200).optional(),
  /** Astra With Sidecar の子が返す返却項目 (spec/feature/astra-with-sidecar.md)。 */
  sidecar_return: z.object({
    summary: z.string().max(4000).optional(),
    commits: z.array(z.string().max(200)).max(50).optional(),
    verification_done: z.array(z.string().max(1000)).max(50).optional(),
    verification_skipped: z.array(z.string().max(1000)).max(50).optional(),
    remaining: z.array(z.string().max(1000)).max(50).optional(),
    consumption: z.string().max(1000).optional(),
    failure_reason: z.string().max(4000).optional(),
    failure_kind: z.enum(["permission", "scope", "unresolved", "quality", "budget", "other"]).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.status === "partial" && (!value.remaining || value.remaining.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remaining"], message: "partial requires remaining[]" });
  }
  if (value.status === "completed" && value.remaining?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remaining"], message: "completed remaining must be empty" });
  }
});
