import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudWorkPlanSchema } from "./runtime-config.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const VariableName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}/g;

export const CLOUD_BATCH_MAX_SHARDS = 100;
export const CLOUD_BATCH_DEFAULT_CONCURRENCY = 1;
export const CLOUD_BATCH_MAX_CONCURRENCY = 10;

/** One fan-out request: a shared instruction template and per-shard variables. */
export const CloudBatchDefinitionSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{1,90}$/),
  targetId: Id,
  taskReference: z.string().regex(/^actio:[A-Za-z0-9-]+$/),
  instructionTemplate: z.string().trim().min(1).max(12_000),
  shards: z.array(z.record(VariableName, z.string().max(1000))).min(1).max(CLOUD_BATCH_MAX_SHARDS),
  concurrency: z.number().int().min(1).max(CLOUD_BATCH_MAX_CONCURRENCY).default(CLOUD_BATCH_DEFAULT_CONCURRENCY),
  computeReason: z.string().trim().min(1).max(1000),
  llmReason: z.string().trim().min(1).max(1000),
  gpuRequired: z.boolean(),
  work: CloudWorkPlanSchema.optional(),
}).strict();
export type CloudBatchDefinition = z.infer<typeof CloudBatchDefinitionSchema>;

export interface PlannedShard { index: number; attemptId: string; instruction: string }

/** Deterministic attempt identity: the same shard can never map to a second attempt. */
export function shardAttemptId(batchId: string, index: number): string {
  return `${batchId}-${String(index + 1).padStart(3, "0")}`;
}

function placeholders(template: string): Set<string> {
  return new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]!));
}

/** Pure expansion. Missing or unused variables are rejected rather than silently rendered. */
export function planCloudBatch(definition: CloudBatchDefinition): PlannedShard[] {
  const names = placeholders(definition.instructionTemplate);
  return definition.shards.map((variables, index) => {
    const keys = Object.keys(variables);
    if (keys.some(key => !names.has(key)) || [...names].some(name => !(name in variables))) {
      throw new Error("cloud_batch_variables_mismatch");
    }
    const instruction = definition.instructionTemplate.replace(PLACEHOLDER, (_, name: string) => variables[name]!);
    if (instruction.length > 12_000) throw new Error("cloud_batch_instruction_too_long");
    return { index, attemptId: shardAttemptId(definition.batchId, index), instruction };
  });
}

export function cloudBatchDefinitionHash(definition: CloudBatchDefinition): string {
  return createHash("sha256").update(JSON.stringify(CloudBatchDefinitionSchema.parse(definition))).digest("hex");
}
