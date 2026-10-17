import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cloudReturnRef } from "./git-receive-policy.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const GrantSchema = z.object({
  targetId: Id, attemptId: Id, repositoryKey: z.string().min(1),
  provider: z.enum(["codex-cloud", "claude-cloud"]),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  ref: z.string(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  maxPackBytes: z.number().int().positive().max(512_000_000),
}).strict().refine(g => g.ref === cloudReturnRef(g.provider, g.attemptId)
  && g.expiresAt > g.issuedAt && g.expiresAt - g.issuedAt <= 6 * 60 * 60 * 1000);
export type GitRunGrant = z.infer<typeof GrantSchema>;
export type GitRunGrantInput = Omit<GitRunGrant, "ref" | "tokenHash">;

const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** A token is returned once to the provider; only its digest enters the journal. */
export class GitRunGrants {
  constructor(private readonly root: string, private readonly entropy: () => Buffer = () => randomBytes(32)) {}

  directory(targetId: string, attemptId: string): string {
    return join(this.root, Id.parse(targetId), Id.parse(attemptId));
  }

  async issue(input: GitRunGrantInput): Promise<{ grant: GitRunGrant; token: string }> {
    const bytes = this.entropy();
    if (bytes.length !== 32) throw new Error("cloud_git_entropy_invalid");
    const token = bytes.toString("base64url");
    const grant = GrantSchema.parse({ ...input, ref: cloudReturnRef(input.provider, input.attemptId), tokenHash: digest(token).toString("hex") });
    const directory = this.directory(input.targetId, input.attemptId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Exclusive creation prevents another launch from rotating an in-flight token.
    const file = await open(join(directory, "grant.json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(grant), "utf8"); await file.sync(); }
    finally { await file.close(); }
    return { grant, token };
  }

  async read(targetId: string, attemptId: string): Promise<GitRunGrant> {
    const bytes = await readFile(join(this.directory(targetId, attemptId), "grant.json"));
    if (bytes.length > 16_384) throw new Error("cloud_git_grant_invalid");
    const grant = GrantSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (grant.targetId !== targetId || grant.attemptId !== attemptId) throw new Error("cloud_git_grant_invalid");
    return grant;
  }

  async authorize(targetId: string, attemptId: string, token: string, now: number): Promise<GitRunGrant> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("cloud_git_unauthorized");
    const grant = await this.read(targetId, attemptId);
    if (!Number.isSafeInteger(now) || now < grant.issuedAt || now >= grant.expiresAt
      || !timingSafeEqual(digest(token), Buffer.from(grant.tokenHash, "hex"))) throw new Error("cloud_git_unauthorized");
    return grant;
  }
}
