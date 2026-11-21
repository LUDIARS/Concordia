import { z } from "zod";
import type { ColabCheckpoint } from "./drive-artifacts.js";
import type { SiteFile } from "./colab-site-schema.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Report = z.object({
  version: z.literal(1), attemptId: z.string(), sourceRevision: z.string(),
  exitCode: z.number().int().safe(),
  tests: z.object({ total: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative() }).strict().optional(),
  metrics: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/), z.number().finite())
    .refine(metrics => Object.keys(metrics).length <= 50).optional(),
  checkpoints: z.array(z.object({ name: z.string().max(120), bytes: z.number().int().safe().nonnegative(),
    sha256: Digest }).strict()).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if ((!value.tests && !value.metrics) || (value.tests && value.tests.failed + value.tests.skipped > value.tests.total)) {
    ctx.addIssue({ code: "custom", message: "invalid result totals" });
  }
});
export type ColabReport = z.infer<typeof Report>;
export type ColabArtifacts = { report: ColabReport; checkpoints: ColabCheckpoint[]; siteFiles?: SiteFile[] };

export function parseColabResult(bytes: Buffer, attemptId: string, revision: string,
  expected: readonly string[], mode: "legacy" | "site" = "legacy"): ColabReport {
  const report = Report.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const names = new Set(report.checkpoints.map(entry => entry.name));
  if (report.attemptId !== attemptId || report.sourceRevision !== revision || names.size !== report.checkpoints.length
    || report.checkpoints.some(checkpoint => !expected.includes(checkpoint.name))
    || (mode === "legacy" && (report.exitCode < 0 || report.exitCode > 255
      || report.checkpoints.some(checkpoint => checkpoint.bytes === 0 || checkpoint.name.length > 101)))
    || (report.exitCode === 0 && names.size !== expected.length)) {
    throw new Error("cloud_colab_report_invalid");
  }
  return report;
}
