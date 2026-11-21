import { z } from "zod";

const Key = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const RelativeProgram = z.string().regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(py|ipynb)$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ColabSiteId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export const ColabSiteGpu = z.enum(["T4", "L4", "G4", "H100", "A100"]);
export const ColabSiteFileName = z.string().max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(name => !name.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));

const Binding = z.object({
  ownerId: z.string().min(1).max(150),
  organizationId: z.string().min(1).max(150),
  destination: Key,
  code: z.literal("public"),
  data: z.literal("non_confidential"),
  programSha256: Digest,
  maxSeconds: z.number().int().min(30).max(1800),
  usageUnitsPerMinute: z.number().positive().finite(),
  maxUsageUnits: z.number().positive().finite(),
  drive: z.object({
    credentialRef: Key,
    folderId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
    checkpointNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/)
      .refine(name => name !== "result.json")).min(1).max(20)
      .refine(names => new Set(names).size === names.length),
  }).strict().optional(),
}).strict();
export const LegacyColabBindingSchema = Binding.extend({
  site: z.undefined().optional(),
  credentialRef: Key,
  program: RelativeProgram,
  runtimeSpec: z.object({
    variant: z.literal("VARIANT_GPU"),
    accelerator: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    shape: z.enum(["SHAPE_STANDARD", "SHAPE_HIGHMEM"]),
  }).strict(),
});
export const SiteColabBindingSchema = Binding.extend({
  ownerId: ColabSiteId,
  site: z.object({
    peerId: ColabSiteId,
    programId: ColabSiteId,
    gpu: ColabSiteGpu,
    outputNames: z.array(ColabSiteFileName.refine(name => name !== "cc-result.json")).max(8).default([])
      .refine(names => new Set(names.map(name => name.toLowerCase())).size === names.length),
  }).strict(),
}).superRefine((binding, ctx) => {
  if (binding.drive?.checkpointNames.some(name => binding.site.outputNames.includes(name))) {
    ctx.addIssue({ code: "custom", message: "Colab site and Drive artifact names must differ" });
  }
});
export const ColabBindingSchema = z.union([LegacyColabBindingSchema, SiteColabBindingSchema]);
export type LegacyColabBinding = z.infer<typeof LegacyColabBindingSchema>;
export type SiteColabBinding = z.infer<typeof SiteColabBindingSchema>;
export type ColabBinding = z.infer<typeof ColabBindingSchema>;
