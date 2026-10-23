import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudBatchDefinitionSchema } from "./batch-plan.js";
import { FileCloudBatchStore } from "./batch-store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { repositoryKey: "repo-a", subsidiaryId: null };
const definition = CloudBatchDefinitionSchema.parse({ batchId: "render-1", targetId: "tokyo-codex", taskReference: "actio:task-1",
  instructionTemplate: "Render {{frame}}", shards: [{ frame: "1" }], computeReason: "CPU render", llmReason: "inspect", gpuRequired: false });

async function store() {
  const root = await mkdtemp(join(tmpdir(), "cc-cloud-batch-")); roots.push(root);
  return new FileCloudBatchStore(root);
}

describe("cloud batch journal", () => {
  it("creates once, returns the same record for identical definitions and rejects changes", async () => {
    const s = await store();
    const [a, b] = await Promise.all([s.create(scope, "parent", definition, 1), s.create(scope, "parent", definition, 2)]);
    expect(a.definitionHash).toBe(b.definitionHash);
    expect((await s.read(scope, "render-1"))?.createdAt).toBe(a.createdAt === 1 || b.createdAt === 1 ? 1 : 2);
    await expect(s.create(scope, "parent", { ...definition, concurrency: 2 }, 3)).rejects.toThrow("cloud_batch_conflict");
  });
  it("separates scopes and lists every scope for the background sweep", async () => {
    const s = await store();
    await s.create(scope, "parent", definition, 1);
    const other = { repositoryKey: "repo-b", subsidiaryId: "company-a" };
    await s.create(other, "parent-b", definition, 2);
    expect(await s.list(scope)).toHaveLength(1);
    expect((await s.listAll()).map(b => b.scope)).toEqual([other, scope]);
  });
  it("stops idempotently and only for an existing batch", async () => {
    const s = await store();
    await expect(s.stop(scope, "render-1", 1)).rejects.toThrow("cloud_batch_not_found");
    await s.create(scope, "parent", definition, 1);
    expect(await s.stopped(scope, "render-1")).toBe(false);
    await s.stop(scope, "render-1", 2);
    await s.stop(scope, "render-1", 3);
    expect(await s.stopped(scope, "render-1")).toBe(true);
  });
  it("rejects a tampered record instead of trusting persisted scope or definitions", async () => {
    const s = await store();
    await s.create(scope, "parent", definition, 1);
    const root = roots.at(-1)!;
    const [directory] = await readdir(root);
    const path = join(root, directory!, "render-1.batch.json");
    const record = JSON.parse(await readFile(path, "utf8")) as { definition: { targetId: string } };
    record.definition.targetId = "other-target";
    await writeFile(path, JSON.stringify(record), "utf8");
    await expect(s.read(scope, "render-1")).rejects.toThrow("cloud_batch_journal_incomplete");
    expect(await s.list(scope)).toEqual([]);
  });
});
