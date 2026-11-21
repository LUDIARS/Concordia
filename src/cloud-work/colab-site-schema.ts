import { z } from "zod";
import { ColabSiteFileName, ColabSiteGpu, ColabSiteId } from "./colab-config.js";

export const SITE_RESULT_NAME = "cc-result.json";
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const siteFileLimit = (name: string): number => name === SITE_RESULT_NAME ? MAX_RESULT_BYTES : MAX_ARTIFACT_BYTES;

export const SiteFileSchema = z.object({
  name: ColabSiteFileName,
  bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().refine(file => file.bytes <= siteFileLimit(file.name));
export type SiteFile = z.infer<typeof SiteFileSchema>;
const Files = z.array(SiteFileSchema).max(9).refine(files =>
  new Set(files.map(file => file.name.toLowerCase())).size === files.length);
export const SiteManifestSchema = z.object({ files: Files }).strict();
const Phase = z.enum(["accepted", "allocating", "executing", "collecting", "releasing", "release_unknown", "released"]);
const StopReason = z.enum(["cancelled", "deadline", "interrupted"]);
export const SiteReceiptSchema = z.object({
  id: z.string().uuid(), programId: ColabSiteId, sourceRevision: z.string().regex(/^[0-9a-f]{40}$/), gpu: ColabSiteGpu,
  phase: Phase, outcome: z.enum(["completed", "failed", "unknown", ...StopReason.options]).nullable(),
  stopReason: StopReason.nullable(), createdAt: z.number().int().safe(), deadlineAt: z.number().int().safe(), files: Files,
  events: z.array(z.object({ at: z.number().int().safe(), phase: Phase }).strict()).max(10),
}).strict();
export type SiteReceipt = z.infer<typeof SiteReceiptSchema>;

export interface SiteSubmit {
  idempotencyKey: string;
  ownerId: string;
  ownerStart: true;
  programId: string;
  sourceRevision: string;
  programSha256: string;
  gpu: z.infer<typeof ColabSiteGpu>;
  deadlineAt: number;
  code: "public";
  data: "non_confidential";
}
