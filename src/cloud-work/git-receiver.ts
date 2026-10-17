import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunGrant } from "./git-run-grant.js";
import { parseCloudReceiveCommand } from "./git-receive-policy.js";
import { runCloudGit, type CloudGitCommand } from "./git-process.js";

async function durableRecord(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
  finally { await file.close(); }
}

interface Received { requestHash: string; oid: string; response: string }

/** Isolated repository and receive journal. Never operates on a working checkout. */
export class CloudGitReceiver {
  constructor(private readonly command: CloudGitCommand = runCloudGit) {}

  async prepare(directory: string, sourceRepo: string, grant: GitRunGrant): Promise<void> {
    const repo = join(directory, "receive.git");
    // An interrupted preparation is not silently reused or re-initialized.
    await mkdir(repo, { mode: 0o700 });
    await this.command(repo, ["init", "--bare", `--object-format=${grant.sourceRevision.length === 40 ? "sha1" : "sha256"}`, "."]);
    await this.command(repo, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", "--", sourceRepo, `${grant.sourceRevision}:refs/heads/base`]);
    const actual = (await this.command(repo, ["rev-parse", "refs/heads/base^{commit}"])).toString("utf8").trim();
    if (actual !== grant.sourceRevision) throw new Error("cloud_git_source_mismatch");
    await durableRecord(join(directory, "prepared.json"), { sourceRevision: actual });
  }

  private async prepared(directory: string, grant: GitRunGrant): Promise<string> {
    const value = JSON.parse(await readFile(join(directory, "prepared.json"), "utf8")) as { sourceRevision?: string };
    if (value.sourceRevision !== grant.sourceRevision) throw new Error("cloud_git_source_mismatch");
    return join(directory, "receive.git");
  }

  async advertise(directory: string, grant: GitRunGrant): Promise<Buffer> {
    const repo = await this.prepared(directory, grant);
    const refs = await this.command(repo, ["receive-pack", "--stateless-rpc", "--advertise-refs", "."]);
    return Buffer.concat([Buffer.from("001f# service=git-receive-pack\n0000", "ascii"), refs]);
  }

  async receive(directory: string, grant: GitRunGrant, body: Buffer): Promise<Buffer> {
    if (body.length > grant.maxPackBytes) throw new Error("cloud_git_pack_too_large");
    const parsed = parseCloudReceiveCommand(body, grant.ref, grant.sourceRevision.length === 40 ? 40 : 64);
    const repo = await this.prepared(directory, grant);
    const requestHash = createHash("sha256").update(body).digest("hex");
    const previous = await this.result(directory);
    if (previous) {
      if (previous.requestHash !== requestHash || previous.oid !== parsed.newOid) throw new Error("cloud_git_receive_conflict");
      return Buffer.from(previous.response, "base64");
    }
    // Persist before Git: partial write/crash/concurrent caller remains unknown, never replayed.
    try { await durableRecord(join(directory, "receive-intent.json"), { requestHash, oid: parsed.newOid }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("cloud_git_receive_unknown");
      throw error;
    }
    const response = await this.command(repo, ["-c", "receive.fsckObjects=true", "-c", `receive.maxInputSize=${grant.maxPackBytes}`,
      "-c", "receive.denyDeletes=true", "-c", "receive.denyNonFastForwards=true", "receive-pack", "--stateless-rpc", "."], body);
    const actual = (await this.command(repo, ["rev-parse", `${grant.ref}^{commit}`])).toString("utf8").trim();
    if (actual !== parsed.newOid) throw new Error("cloud_git_received_ref_mismatch");
    await this.command(repo, ["merge-base", "--is-ancestor", grant.sourceRevision, actual]);
    await durableRecord(join(directory, "received.json"), { requestHash, oid: actual, response: response.toString("base64") });
    return response;
  }

  async result(directory: string): Promise<Received | null> {
    let bytes: Buffer;
    try { bytes = await readFile(join(directory, "received.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (bytes.length > 1_500_000) throw new Error("cloud_git_receipt_invalid");
    const value = JSON.parse(bytes.toString("utf8")) as Received;
    if (!/^[a-f0-9]{64}$/.test(value.requestHash) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.oid)
      || typeof value.response !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.response)) throw new Error("cloud_git_receipt_invalid");
    return value;
  }
}
