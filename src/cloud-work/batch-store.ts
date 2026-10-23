import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cloudBatchDefinitionHash, CloudBatchDefinitionSchema, type CloudBatchDefinition } from "./batch-plan.js";
import type { CloudScope } from "./runtime-service.js";

export interface StoredCloudBatch {
  version: 1;
  scope: CloudScope;
  createdBySessionId: string;
  createdAt: number;
  definitionHash: string;
  definition: CloudBatchDefinition;
}

const scopeKey = (scope: CloudScope): string =>
  createHash("sha256").update(JSON.stringify([scope.repositoryKey, scope.subsidiaryId])).digest("hex");
const StoredCloudBatchSchema = z.object({
  version: z.literal(1),
  scope: z.object({ repositoryKey: z.string().min(1), subsidiaryId: z.string().min(1).max(200).nullable() }).strict(),
  createdBySessionId: z.string().min(1).max(200),
  createdAt: z.number().finite().nonnegative(),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  definition: CloudBatchDefinitionSchema,
}).strict();
const MAX_BATCH_RECORD_BYTES = 300_000;

async function readStoredBatch(path: string, expectedScopeKey: string, expectedBatchId?: string): Promise<StoredCloudBatch> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_BATCH_RECORD_BYTES) throw new Error("cloud_batch_journal_incomplete");
  const value = StoredCloudBatchSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (scopeKey(value.scope) !== expectedScopeKey
    || (expectedBatchId !== undefined && value.definition.batchId !== expectedBatchId)
    || cloudBatchDefinitionHash(value.definition) !== value.definitionHash) {
    throw new Error("cloud_batch_journal_incomplete");
  }
  return value;
}

async function writeExclusive(path: string, value: unknown): Promise<boolean> {
  const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!handle) return false;
  try {
    await handle.writeFile(JSON.stringify(value), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Durable batch definitions. A definition is immutable; stopping adds a marker. */
export class FileCloudBatchStore {
  constructor(private readonly root: string) {}

  private directory(scope: CloudScope): string { return join(this.root, scopeKey(scope)); }
  private path(scope: CloudScope, batchId: string, suffix: "batch" | "stop"): string {
    if (!/^[A-Za-z0-9_-]{1,90}$/.test(batchId)) throw new Error("invalid_cloud_batch_id");
    return join(this.directory(scope), `${batchId}.${suffix}.json`);
  }

  /** Insert-if-absent. An existing batch with a different definition is a conflict. */
  async create(scope: CloudScope, createdBySessionId: string, definition: CloudBatchDefinition, now: number): Promise<StoredCloudBatch> {
    const parsed = CloudBatchDefinitionSchema.parse(definition);
    const record: StoredCloudBatch = { version: 1, scope, createdBySessionId, createdAt: now,
      definitionHash: cloudBatchDefinitionHash(parsed), definition: parsed };
    await mkdir(this.directory(scope), { recursive: true, mode: 0o700 });
    if (await writeExclusive(this.path(scope, parsed.batchId, "batch"), record)) return record;
    const existing = await this.read(scope, parsed.batchId);
    if (!existing || existing.definitionHash !== record.definitionHash) throw new Error("cloud_batch_conflict");
    return existing;
  }

  async read(scope: CloudScope, batchId: string): Promise<StoredCloudBatch | null> {
    try {
      return await readStoredBatch(this.path(scope, batchId, "batch"), scopeKey(scope), batchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("cloud_batch_journal_incomplete");
    }
  }

  async stop(scope: CloudScope, batchId: string, now: number): Promise<void> {
    if (!await this.read(scope, batchId)) throw new Error("cloud_batch_not_found");
    await writeExclusive(this.path(scope, batchId, "stop"), { stoppedAt: now });
  }

  async stopped(scope: CloudScope, batchId: string): Promise<boolean> {
    try { await readFile(this.path(scope, batchId, "stop")); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("cloud_batch_journal_incomplete");
    }
  }

  async list(scope: CloudScope): Promise<StoredCloudBatch[]> {
    return this.readDirectory(this.directory(scope), scopeKey(scope));
  }

  /** Every scope's batches, for the background kicker. Scope is taken from each record. */
  async listAll(): Promise<StoredCloudBatch[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const batches: StoredCloudBatch[] = [];
    for (const name of names.filter(n => /^[a-f0-9]{64}$/.test(n))) {
      batches.push(...await this.readDirectory(join(this.root, name), name));
    }
    return batches;
  }

  private async readDirectory(directory: string, expectedScopeKey: string): Promise<StoredCloudBatch[]> {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const batches: StoredCloudBatch[] = [];
    for (const name of names.filter(n => /^[A-Za-z0-9_-]{1,90}\.batch\.json$/.test(n))) {
      try {
        const batchId = name.slice(0, -".batch.json".length);
        batches.push(await readStoredBatch(join(directory, name), expectedScopeKey, batchId));
      } catch { /* An unreadable record is skipped here and reported by read(). */ }
    }
    return batches.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }
}
