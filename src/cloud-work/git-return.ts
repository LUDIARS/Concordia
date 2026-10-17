import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRunGrants } from "./git-run-grant.js";
import { CloudGitReceiver } from "./git-receiver.js";
import { runCloudGit, type CloudGitCommand } from "./git-process.js";
import type { CloudTarget } from "./runtime-config.js";
import type { CloudSubmission } from "./submission.js";
import { verifyGitArtifactTree } from "./git-artifact-policy.js";

export type SubmitCloudLocalPr = (request: { repoPath: string; branch: string; prContent: string }) => Promise<unknown>;

async function record(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
  finally { await file.close(); }
}

/** Prepares private return capabilities and promotes verified results through existing review. */
export class CloudGitReturn {
  private readonly grants: GitRunGrants;
  private readonly receiver: CloudGitReceiver;
  constructor(root: string, private readonly env: NodeJS.ProcessEnv, private readonly repositoryKey: (path: string) => Promise<string>,
    private readonly review: SubmitCloudLocalPr, private readonly command: CloudGitCommand = runCloudGit,
    private readonly now: () => number = Date.now) {
    this.grants = new GitRunGrants(root);
    this.receiver = new CloudGitReceiver(command);
  }

  async instructions(target: CloudTarget, request: CloudSubmission): Promise<string> {
    if (target.transferMode !== "git" || !target.git) throw new Error("cloud_git_binding_missing");
    const accessValue = this.env[target.git.accessHeaderEnv];
    if (!accessValue || /[\r\n]/.test(accessValue)) throw new Error("cloud_git_access_binding_missing");
    const issuedAt = this.now();
    const { grant, token } = await this.grants.issue({ targetId: target.id, attemptId: request.attemptId,
      repositoryKey: await this.repositoryKey(target.repoPath), provider: target.provider, sourceRevision: target.sourceRevision,
      issuedAt, expiresAt: issuedAt + 3_600_000, maxPackBytes: target.maxArtifactBytes });
    await this.receiver.prepare(this.grants.directory(target.id, request.attemptId), target.repoPath, grant);
    const url = `https://${target.git.publicHost}/git/${target.id}/${request.attemptId}.git`;
    return [
      "Transfer mode: Git. Commit the requested artifacts, then push exactly HEAD to the allocated new ref below, once.",
      "Before work disable push URLs of every existing remote (including origin) and install a pre-push guard allowing only this destination/ref. Do not push to GitHub or create a GitHub PR.",
      "Treat the following capability as secret: never print it, commit it, put credentials in a URL, or persist it in Git config.",
      "Use an ephemeral credential helper for HTTP Basic username run/password token; scope it to this exact URL. Supply the Access header only to this exact HTTPS host using process-scoped HTTP configuration. Disable redirects. Clear these capabilities after the push.",
      "Do not send tags, force updates, other branches, or push options. On ambiguous output stop and report; do not retry or choose S3.",
      JSON.stringify({ url, ref: grant.ref, username: "run", token, accessHeaderName: target.git.accessHeaderName, accessHeaderValue: accessValue,
        sourceRevision: grant.sourceRevision, maxPackBytes: grant.maxPackBytes, expectedArtifacts: target.expectedNames }),
    ].join("\n");
  }

  async collect(target: CloudTarget, attemptId: string): Promise<unknown> {
    const grant = await this.grants.read(target.id, attemptId);
    if (grant.repositoryKey !== await this.repositoryKey(target.repoPath) || grant.sourceRevision !== target.sourceRevision) throw new Error("cloud_git_repository_changed");
    const directory = this.grants.directory(target.id, attemptId);
    const result = await this.receiver.result(directory);
    if (!result) throw new Error("cloud_git_result_not_received");
    const receiptPath = join(directory, "review-receipt.json");
    try { return JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(directory, { recursive: true });
    // Reservation precedes promotion and external review: no duplicate PR after crash.
    try { await record(join(directory, "review-intent.json"), { oid: result.oid }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("cloud_git_review_unknown"); throw error; }
    const repo = join(directory, "receive.git");
    await this.command(repo, ["merge-base", "--is-ancestor", grant.sourceRevision, result.oid]);
    verifyGitArtifactTree(await this.command(repo, ["ls-tree", "-l", "-z", result.oid, "--", ...target.expectedNames]), target.expectedNames, target.maxArtifactBytes);
    const worktrees = (await this.command(target.repoPath, ["worktree", "list", "--porcelain"])).toString("utf8");
    if (worktrees.split(/\r?\n/).includes(`branch ${grant.ref}`)) throw new Error("cloud_git_branch_checked_out");
    await this.command(target.repoPath, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", "--", repo, result.oid]);
    await this.command(target.repoPath, ["update-ref", grant.ref, result.oid, "0".repeat(result.oid.length)]);
    const review = await this.review({ repoPath: target.repoPath, branch: grant.ref.slice("refs/heads/".length),
      prContent: `Cloud work ${target.id}/${attemptId}\nSource: ${grant.sourceRevision}\nResult: ${result.oid}\nBoundary: isolated cloud Git return. Recovery: retain receive/review journals; never retry unknown submission.\nValidation: transport identity and source ancestry verified. Artifact behavior and acceptance require Revisor review.` });
    const pr = (review as { pullRequest?: { id?: unknown; number?: unknown; status?: unknown } } | null)?.pullRequest;
    const submitted = !!pr && typeof pr.id === "string" && typeof pr.number === "number" && pr.status === "open";
    const receipt = { state: submitted ? "review_submitted" : "review_submission_unconfirmed", oid: result.oid, review };
    await record(receiptPath, receipt);
    return receipt;
  }
}
