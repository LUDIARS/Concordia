import { z } from "zod";

const Key = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const RelativeProgram = z.string().regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(py|ipynb)$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const ColabBindingSchema = z.object({
  ownerId: z.string().min(1).max(150),
  organizationId: z.string().min(1).max(150),
  credentialRef: Key,
  destination: Key,
  code: z.literal("public"),
  data: z.literal("non_confidential"),
  program: RelativeProgram,
  programSha256: Digest,
  runtimeSpec: z.object({
    variant: z.literal("VARIANT_GPU"),
    accelerator: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    shape: z.enum(["SHAPE_STANDARD", "SHAPE_HIGHMEM"]),
  }).strict(),
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
export type ColabBinding = z.infer<typeof ColabBindingSchema>;
