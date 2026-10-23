import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudTarget, CloudEnvironment, CloudWorkPlan } from "./runtime-config.js";
import { cloudTargetReady, resolveCloudWork, CloudWorkPlanSchema } from "./runtime-config.js";
import { FileCloudSubmissionStore } from "./file-submission-store.js";
import { submitCloudWork, type CloudSubmission, type CloudSubmitter } from "./submission.js";
import { verifyCloudArtifacts } from "./artifact-verification.js";
import type { AttemptJournal } from "./batch-policy.js";

export interface CloudScope { repositoryKey: string; subsidiaryId: string | null }
export interface CloudWorkInput {
  attemptId: string; targetId: string; taskReference: string; instruction: string;
  computeReason: string; llmReason: string; gpuRequired: boolean;
  work?: CloudWorkPlan;
}
interface StoredRun extends CloudSubmission { targetId: string; work?: CloudWorkPlan; inputWorkHash?: string; transferMode?: "git" | "s3"; configurationKey: string; computeReason: string; llmReason: string; createdAt: number }
export interface CloudRuntimePorts {
  root: string;
  targets(): Promise<CloudEnvironment[]>;
  repositoryKey(path: string): Promise<string>;
  authorizeTask(reference: string, scope: CloudScope, requireActive?: boolean): Promise<void>;
  preflight(target: CloudTarget): Promise<void>;
  adapter(target: CloudTarget): CloudSubmitter;
  collect(target: CloudTarget, attemptId: string): Promise<{ manifest: unknown; received: Map<string, Buffer> }>;
  collectGit?(target: CloudTarget, attemptId: string): Promise<unknown>;
  env: NodeJS.ProcessEnv;
  now(): number;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const configurationKey = (target: CloudTarget, legacyS3 = false): string => hash(JSON.stringify({ id: target.id,
  provider: target.provider, environmentId: target.environmentId, sourceRevision: target.sourceRevision,
  transferMode: legacyS3 ? undefined : target.transferMode, git: legacyS3 ? undefined : target.git,
  storage: target.storage, expectedNames: target.expectedNames, maxArtifactBytes: target.maxArtifactBytes }));

/** Application orchestration; Actio state is never inferred from transport outcomes. */
export class CloudWorkRuntime {
  private readonly collections = new Map<string, Promise<unknown>>();
  constructor(private readonly ports: CloudRuntimePorts) {}

  private root(scope: CloudScope): string { return join(this.ports.root, hash(JSON.stringify([scope.repositoryKey, scope.subsidiaryId]))); }
  private store(scope: CloudScope): FileCloudSubmissionStore { return new FileCloudSubmissionStore(this.root(scope)); }

  async targets(scope: CloudScope): Promise<CloudEnvironment[]> {
    const result: CloudEnvironment[] = [];
    for (const target of await this.ports.targets()) {
      if (target.subsidiaryId === scope.subsidiaryId
        && await this.ports.repositoryKey(target.repoPath) === scope.repositoryKey) result.push(target);
    }
    return result;
  }

  async availability(scope: CloudScope): Promise<Array<{ id: string; label: string; provider: string; transferMode: string; ready: boolean }>> {
    return (await this.targets(scope)).map(t => ({ id: t.id, label: t.label, provider: t.provider,
      transferMode: t.transferMode, ready: cloudTargetReady(t, this.ports.env, this.ports.now()) }));
  }

  private async target(scope: CloudScope, id: string): Promise<CloudEnvironment> {
    const target = (await this.targets(scope)).find(t => t.id === id);
    if (!target) throw new Error("cloud_target_not_found");
    return target;
  }

  async submit(scope: CloudScope, input: CloudWorkInput): Promise<unknown> {
    const environment = await this.target(scope, input.targetId);
    await this.ports.authorizeTask(input.taskReference, scope, true);
    if (!input.computeReason.trim() || !input.llmReason.trim()) throw new Error("cloud_work_evidence_missing");
    const store = this.store(scope);
    // Avoid even a preflight after an ambiguous submission. The same ID is never replayed.
    const existing = await store.readRecord(input.attemptId, "intent");
    if (existing) {
      const run = existing as StoredRun;
      if (!this.sameRequest(run, input)) {
        throw new Error("cloud_attempt_conflict");
      }
      return this.status(scope, input.attemptId);
    }
    const target = resolveCloudWork(environment, input.work);
    if (!cloudTargetReady(target, this.ports.env, this.ports.now())) throw new Error("cloud_target_not_ready");
    await this.ports.preflight(target);
    const request: StoredRun = {
      attemptId: input.attemptId, targetId: target.id, transferMode: target.transferMode, taskReference: input.taskReference,
      work: CloudWorkPlanSchema.parse(Object.fromEntries(Object.keys(CloudWorkPlanSchema.shape).map(key => [key, target[key as keyof CloudTarget]]))),
      inputWorkHash: hash(JSON.stringify(input.work ? CloudWorkPlanSchema.parse(input.work) : null)),
      computeReason: input.computeReason, llmReason: input.llmReason, createdAt: this.ports.now(),
      configurationKey: configurationKey(target), provider: target.provider, environmentId: target.environmentId,
      sourceRevision: target.sourceRevision, instruction: input.instruction,
      eligibility: { repositoryBytes: target.repositoryBytes, environmentPreparable: target.environmentPreparable,
        requiresLargeProjectClone: target.requiresLargeProjectClone, computeIntensiveArtifactGeneration: true, requiresLlmGuidance: true },
      standardHosted: target.standardHosted, gpuRequired: input.gpuRequired, gpuVerified: target.gpuVerified,
      sourceAvailable: true, artifactTransferReady: true,
    };
    const receipt = await submitCloudWork(request, store, this.ports.adapter(target));
    if (receipt.state === "already_reserved" && !this.sameRequest(await this.run(scope, input.attemptId), input)) {
      throw new Error("cloud_attempt_conflict");
    }
    return this.status(scope, input.attemptId);
  }

  private sameRequest(run: StoredRun, input: CloudWorkInput): boolean {
    return run.targetId === input.targetId && run.taskReference === input.taskReference
      && run.instruction === input.instruction && run.gpuRequired === input.gpuRequired
      && run.computeReason === input.computeReason && run.llmReason === input.llmReason
      && (run.inputWorkHash ?? hash("null")) === hash(JSON.stringify(input.work ? CloudWorkPlanSchema.parse(input.work) : null));
  }

  private async run(scope: CloudScope, attemptId: string): Promise<StoredRun> {
    const value = await this.store(scope).readRecord(attemptId, "intent") as StoredRun | null;
    if (!value || value.attemptId !== attemptId || !value.targetId || !value.taskReference) throw new Error("cloud_attempt_not_found");
    await this.ports.authorizeTask(value.taskReference, scope);
    return value;
  }

  async status(scope: CloudScope, attemptId: string): Promise<unknown> {
    const run = await this.run(scope, attemptId), store = this.store(scope);
    const receipt = await store.readRecord(attemptId, "receipt");
    const reconciliation = await store.readRecord(attemptId, "reconciliation");
    const verified = await store.readRecord(attemptId, "verified");
    return { attemptId, taskReference: run.taskReference, provider: run.provider, targetId: run.targetId, transferMode: run.transferMode ?? "s3",
      receipt: receipt ?? { state: "submission_unknown" }, reconciliation, verified,
      state: verified ? (run.transferMode === "git" ? (verified as { state: string }).state : "artifacts_verified")
        : (receipt as { state?: string } | null)?.state ?? "submission_unknown" };
  }

  /** Journal facts only; task authorization is the caller's responsibility. */
  async attemptJournal(scope: CloudScope, attemptId: string): Promise<AttemptJournal> {
    const store = this.store(scope);
    const intent = await store.readRecord(attemptId, "intent");
    if (!intent) {
      return { intent: false, receipt: null, reconciliationRemoteId: null, verified: false };
    }
    if (typeof intent !== "object" || (intent as { attemptId?: unknown }).attemptId !== attemptId
      || !["codex-cloud", "claude-cloud"].includes(String((intent as { provider?: unknown }).provider))) {
      throw new Error("cloud_journal_incomplete");
    }
    const provider = (intent as { provider: "codex-cloud" | "claude-cloud" }).provider;
    const validRemoteId = (value: unknown): value is string => typeof value === "string"
      && (provider === "codex-cloud" ? /^task_[A-Za-z0-9_-]+$/ : /^session_[A-Za-z0-9_-]+$/).test(value)
      && value.length <= 200;
    const receiptValue = await store.readRecord(attemptId, "receipt");
    let receipt: AttemptJournal["receipt"] = null;
    if (receiptValue !== null) {
      if (typeof receiptValue !== "object") throw new Error("cloud_journal_incomplete");
      const candidate = receiptValue as { state?: unknown; remoteId?: unknown };
      if (candidate.state === "submission_unknown") receipt = { state: "submission_unknown" };
      else if (candidate.state === "submitted" && validRemoteId(candidate.remoteId)) {
        receipt = { state: "submitted", remoteId: candidate.remoteId };
      }
      else throw new Error("cloud_journal_incomplete");
    }
    const reconciliation = await store.readRecord(attemptId, "reconciliation");
    const reconciliationRemoteId = reconciliation === null ? null
      : typeof reconciliation === "object" && validRemoteId((reconciliation as { remoteId?: unknown }).remoteId)
        ? (reconciliation as { remoteId: string }).remoteId : null;
    if (reconciliation !== null && reconciliationRemoteId === null) throw new Error("cloud_journal_incomplete");
    return { intent: true, receipt, reconciliationRemoteId, verified: !!await store.readRecord(attemptId, "verified") };
  }

  async list(scope: CloudScope): Promise<unknown[]> {
    let names: string[];
    try { names = await readdir(this.root(scope)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const runs: StoredRun[] = [];
    for (const name of names.filter(n => /^[A-Za-z0-9_-]{1,100}\.intent\.json$/.test(n))) {
      const attemptId = name.slice(0, -".intent.json".length);
      runs.push(await this.run(scope, attemptId));
    }
    return Promise.all(runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(r => this.status(scope, r.attemptId)));
  }

  async reconcile(scope: CloudScope, attemptId: string, remoteId: string): Promise<unknown> {
    const run = await this.run(scope, attemptId);
    if (!(run.provider === "codex-cloud" ? /^task_[A-Za-z0-9_-]+$/ : /^session_[A-Za-z0-9_-]+$/).test(remoteId)) {
      throw new Error("invalid_cloud_remote_id");
    }
    await this.store(scope).writeRecord(attemptId, "reconciliation", { remoteId, source: "operator_observation" });
    return this.status(scope, attemptId);
  }

  async collect(scope: CloudScope, attemptId: string): Promise<unknown> {
    const key = `${this.root(scope)}/${attemptId}`;
    const pending = this.collections.get(key);
    if (pending) return pending;
    const collection = this.collectOnce(scope, attemptId);
    this.collections.set(key, collection);
    try { return await collection; }
    finally { this.collections.delete(key); }
  }

  private async collectOnce(scope: CloudScope, attemptId: string): Promise<unknown> {
    const run = await this.run(scope, attemptId), store = this.store(scope);
    if (await store.readRecord(attemptId, "verified")) return this.status(scope, attemptId);
    const target = resolveCloudWork(await this.target(scope, run.targetId), run.work);
    if ((!run.transferMode && target.transferMode !== "s3")
      || configurationKey(target, !run.transferMode) !== run.configurationKey) throw new Error("cloud_target_configuration_changed");
    if (run.transferMode === "git") {
      if (!this.ports.collectGit) throw new Error("cloud_git_collection_unavailable");
      await store.writeRecord(attemptId, "verified", await this.ports.collectGit(target, attemptId));
      return this.status(scope, attemptId);
    }
    const result = await this.ports.collect(target, attemptId);
    const verified = verifyCloudArtifacts({ ...result, attemptId, sourceRevision: run.sourceRevision,
      expectedNames: target.expectedNames, maxTotalBytes: target.maxArtifactBytes });
    const directory = join(this.root(scope), `${attemptId}.artifacts`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The verified marker is written last. Partial collection is never downloadable.
    for (const artifact of verified.artifacts) {
      await writeFile(join(directory, artifact.name), result.received.get(artifact.name)!, { mode: 0o600 });
    }
    await store.writeRecord(attemptId, "verified", verified);
    return this.status(scope, attemptId);
  }

  async download(scope: CloudScope, attemptId: string, name: string): Promise<Buffer> {
    await this.run(scope, attemptId);
    const verified = await this.store(scope).readRecord(attemptId, "verified") as { artifacts?: Array<{ name: string; bytes: number; sha256: string }> } | null;
    const artifact = verified?.artifacts?.find(a => a.name === name);
    if (!artifact || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name)) throw new Error("cloud_artifact_not_found");
    const bytes = await readFile(join(this.root(scope), `${attemptId}.artifacts`, name));
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error("cloud_artifact_integrity_failed");
    }
    return bytes;
  }
}
