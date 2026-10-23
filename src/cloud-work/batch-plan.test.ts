import { describe, expect, it } from "vitest";
import { cloudBatchDefinitionHash, CloudBatchDefinitionSchema, planCloudBatch, shardAttemptId } from "./batch-plan.js";

const base = { batchId: "render-1", targetId: "tokyo-codex", taskReference: "actio:task-1",
  instructionTemplate: "Render frames {{start}}-{{end}}", shards: [{ start: "1", end: "10" }, { start: "11", end: "20" }],
  computeReason: "CPU render", llmReason: "inspect preview", gpuRequired: false };

describe("cloud batch plan", () => {
  it("defaults to one shard in flight (neco: minimum unit 1)", () => {
    expect(CloudBatchDefinitionSchema.parse(base).concurrency).toBe(1);
    expect(CloudBatchDefinitionSchema.safeParse({ ...base, concurrency: 11 }).success).toBe(false);
    expect(CloudBatchDefinitionSchema.safeParse({ ...base, concurrency: 0 }).success).toBe(false);
  });
  it("expands each shard into a deterministic attempt", () => {
    const shards = planCloudBatch(CloudBatchDefinitionSchema.parse(base));
    expect(shards).toEqual([
      { index: 0, attemptId: "render-1-001", instruction: "Render frames 1-10" },
      { index: 1, attemptId: "render-1-002", instruction: "Render frames 11-20" },
    ]);
    expect(shardAttemptId("render-1", 99)).toBe("render-1-100");
  });
  it.each([[{ start: "1" }], [{ start: "1", end: "2", extra: "x" }]])("rejects missing or unused variables", shard => {
    expect(() => planCloudBatch(CloudBatchDefinitionSchema.parse({ ...base, shards: [shard] }))).toThrow("cloud_batch_variables_mismatch");
  });
  it("bounds shard count and keeps the definition hash stable", () => {
    expect(CloudBatchDefinitionSchema.safeParse({ ...base, shards: Array(101).fill({ start: "1", end: "2" }) }).success).toBe(false);
    const parsed = CloudBatchDefinitionSchema.parse(base);
    expect(cloudBatchDefinitionHash(parsed)).toBe(cloudBatchDefinitionHash(CloudBatchDefinitionSchema.parse(base)));
    expect(cloudBatchDefinitionHash(parsed)).not.toBe(cloudBatchDefinitionHash({ ...parsed, concurrency: 2 }));
  });
});
