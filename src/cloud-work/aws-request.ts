import { z } from "zod";

export const AwsId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const AwsAttempt = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const AwsSession = z.string().min(1).max(200);
export const AwsTask = z.string().max(100).regex(/^actio:[A-Za-z0-9-]+$/);
export const AwsInputKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const AWS_ARTIFACT_ATTEMPT_KEY = "CC_CLOUD_ATTEMPT_ID";

export const AwsRequestSchema = z.object({
  attemptId: AwsAttempt,
  taskReference: AwsTask,
  targetId: AwsId,
  runner: AwsId,
  inputs: z.record(AwsInputKey, z.string().max(512).regex(/^[^\u0000]*$/u))
    .refine(inputs => Object.keys(inputs).length <= 16 && !Object.hasOwn(inputs, AWS_ARTIFACT_ATTEMPT_KEY)),
  deadline: z.string().datetime({ offset: true }),
  evidence: z.object({ code: z.literal("public"), data: z.literal("non_confidential"), destination: AwsId }).strict(),
}).strict();
export type AwsRequest = z.infer<typeof AwsRequestSchema>;
