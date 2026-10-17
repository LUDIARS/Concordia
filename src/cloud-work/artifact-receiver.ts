import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Grant = z.object({
  target: Id, attempt: Id,
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/)
    .refine(name => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) && !name.endsWith(".")),
  maxBytes: z.number().int().positive().max(2_000_000_000),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(g => g.expiresAt > g.issuedAt && g.expiresAt - g.issuedAt <= 21_600_000);
export type ArtifactGrant = z.infer<typeof Grant>;
export type ArtifactGrantInput = Omit<ArtifactGrant, "tokenHash">;
const Receipt = z.object({ name: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ArtifactReceipt = z.infer<typeof Receipt>;
const hash = (value: string): Buffer => createHash("sha256").update(value).digest();

async function exclusiveJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
  finally { await file.close(); }
}

/** Owns durable receive state; no cloud, review or service-control side effects. */
export class ArtifactReceiver {
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private async directory(target: string, attempt: string): Promise<string> {
    let path = this.root;
    for (const component of ["", Id.parse(target), Id.parse(attempt)]) {
      if (component) path = join(path, component);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact_directory_invalid");
    }
    return path;
  }

  /** Trusted local callers only. Return secret once; never persist its plaintext. */
  async issue(input: ArtifactGrantInput): Promise<{ token: string; grant: ArtifactGrant }> {
    const token = randomBytes(32).toString("base64url");
    const grant = Grant.parse({ ...input, tokenHash: hash(token).toString("hex") });
    // Validate each existing parent before creating a child (Windows junctions included).
    let path = this.root;
    for (const component of ["", grant.target, grant.attempt]) {
      if (component) { path = join(path, component); await mkdir(path, { recursive: false, mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }); }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact_directory_invalid");
    }
    await exclusiveJson(join(path, "grant.json"), grant);
    return { token, grant };
  }

  async authorize(target: string, attempt: string, token: string): Promise<ArtifactGrant> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("artifact_unauthorized");
    const directory = await this.directory(target, attempt);
    const grant = Grant.parse(JSON.parse(await readFile(join(directory, "grant.json"), "utf8")));
    const now = this.now();
    if (grant.target !== target || grant.attempt !== attempt || now < grant.issuedAt || now >= grant.expiresAt
      || !timingSafeEqual(hash(token), Buffer.from(grant.tokenHash, "hex"))) throw new Error("artifact_unauthorized");
    return grant;
  }

  async status(grant: ArtifactGrant): Promise<{ state: "pending" | "unknown" | "received"; receipt?: ArtifactReceipt }> {
    const directory = await this.directory(grant.target, grant.attempt);
    try {
      const receipt = Receipt.parse(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")));
      if (receipt.name !== grant.name || receipt.bytes > grant.maxBytes) throw new Error("artifact_receipt_invalid");
      return { state: "received", receipt };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await lstat(join(directory, "intent.json")); return { state: "unknown" }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { state: "pending" }; }
  }

  async receive(grant: ArtifactGrant, token: string, bytes: number, sha256: string,
    body: ReadableStream<Uint8Array>): Promise<ArtifactReceipt> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > grant.maxBytes || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("artifact_size_or_hash_invalid");
    const status = await this.status(grant);
    if (status.state === "received" && status.receipt?.bytes === bytes && status.receipt.sha256 === sha256) return status.receipt;
    if (status.state !== "pending") throw new Error("artifact_reconcile_required");
    const directory = await this.directory(grant.target, grant.attempt);
    await exclusiveJson(join(directory, "intent.json"), { bytes, sha256 });
    const file = await open(join(directory, "payload.partial"), "wx", 0o600);
    const reader = body.getReader();
    let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => { /* disconnected request */ }); }, 120_000);
    const digest = createHash("sha256");
    let count = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        count += part.value.byteLength;
        if (expired || count > bytes) throw new Error("artifact_size_or_timeout");
        digest.update(part.value);
        let offset = 0;
        while (offset < part.value.byteLength) {
          const result = await file.write(part.value, offset, part.value.byteLength - offset);
          if (!result.bytesWritten) throw new Error("artifact_write_failed");
          offset += result.bytesWritten;
        }
      }
      if (expired || count !== bytes || digest.digest("hex") !== sha256) throw new Error("artifact_integrity_failed");
      await this.authorize(grant.target, grant.attempt, token);
      await file.sync();
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => { /* disconnected request; preserve partial bytes */ });
      reader.releaseLock();
      await file.close();
    }
    // Fixed payload name avoids client filenames colliding with internal journals.
    await rename(join(directory, "payload.partial"), join(directory, "payload"));
    const receipt = { name: grant.name, bytes, sha256 };
    await exclusiveJson(join(directory, "receipt.json"), receipt);
    return receipt;
  }
}
