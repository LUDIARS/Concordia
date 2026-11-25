import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudTarget, CloudEnvironment, CloudWorkPlan } from "./runtime-config.js";
import { cloudTargetReady, driveArtifactNames, resolveCloudWork, CloudWorkPlanSchema } from "./runtime-config.js";
import { FileCloudSubmissionStore } from "./file-submission-store.js";
import { submitCloudWork, type CloudSubmission, type CloudSubmitter } from "./submission.js";
import { executionEvidence, requestFingerprint, type CloudExecutionAdapter, type ExecutionIdentity, type ProviderTerminal } from "./execution-adapter.js";
import type { CloudReceipt } from "./submission.js";
import { verifyCloudArtifacts } from "./artifact-verification.js";
import type { AttemptJournal } from "./batch-policy.js";
import type { ScheduledCloudOrigin } from "./eligibility.js";

export interface CloudScope { repositoryKey: string; subsidiaryId: string | null }
export interface CloudWorkInput {
  attemptId: string; targetId: string; taskReference: string; instruction: string;
  computeReason: string; llmReason: string; gpuRequired: boolean;
  work?: CloudWorkPlan;
}
interface StoredRun extends CloudSubmission { targetId: string; work?: CloudWorkPlan; inputWorkHash?: string; transferMode?: CloudTarget["transferMode"]; configurationKey: string; computeReason: string; llmReason: string; createdAt: number }
export interface CloudRuntimePorts {
  root: string;
  targets(): Promise<CloudEnvironment[]>;
  repositoryKey(path: string): Promise<string>;
  authorizeTask(reference: string, scope: CloudScope, requireActive?: boolean): Promise<void>;
  preflight(target: CloudTarget): Promise<void>;
  adapter(target: CloudTarget, attemptId?: string): CloudSubmitter & Partial<CloudExecutionAdapter<CloudSubmission, Awaited<ReturnType<CloudRuntimePorts["collect"]>>>>;
  collect(target: CloudTarget, attemptId: string): Promise<{ manifest: unknown; received: Map<string, Buffer> }>;
  collectGit?(target: CloudTarget, attemptId: string): Promise<unknown>;
  workerReport?(targetId: string, attemptId: string): Promise<unknown>;
  env: NodeJS.ProcessEnv;
  now(): number;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const configurationKey = (target: CloudTarget, legacyS3 = false): string => hash(JSON.stringify({ id: target.id,
  provider: target.provider, environmentId: target.environmentId, sourceRevision: target.sourceRevision,
  transferMode: legacyS3 ? undefined : target.transferMode, git: legacyS3 ? undefined : target.git,
  storage: target.storage, expectedNames: target.expectedNames, maxArtifactBytes: target.maxArtifactBytes,
  // Absent for targets without Drive, so their existing keys stay unchanged.
  drive: target.drive, driveExpectedNames: target.driveExpectedNames }));

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
    return (await this.targets(scope)).filter(t => t.provider !== "colab").map(t => ({ id: t.id, label: t.label, provider: t.provider,
      transferMode: t.transferMode, ready: cloudTargetReady(t, this.ports.env, this.ports.now()) }));
  }

  async kaizenTarget(scope: CloudScope): Promise<string | null> {
    if (scope.subsidiaryId !== null) return null;
    for (const target of await this.targets(scope)) {
      if (!this.isKaizenTarget(target) || !cloudTargetReady(target, this.ports.env, this.ports.now())) continue;
      try { return resolveCloudWork(target).id; }
      catch { /* A Kaizen request uses the operator's fixed work evidence. Try the next configured target. */ }
    }
    return null;
  }

  private isKaizenTarget(target: CloudEnvironment): boolean {
    return target.provider === "codex-cloud" && target.transferMode === "git" && !target.driveExpectedNames?.length;
  }

  private async target(scope: CloudScope, id: string): Promise<CloudEnvironment> {
    const target = (await this.targets(scope)).find(t => t.id === id);
    if (!target) throw new Error("cloud_target_not_found");
    return target;
  }

  async submit(scope: CloudScope, input: CloudWorkInput): Promise<unknown> {
    return this.submitWork(scope, input);
  }

  /** Trusted entry point for the HQ scheduler. The HTTP and MCP routes call submit(). */
  async submitKaizen(
    scope: CloudScope, input: CloudWorkInput, mayLaunch: () => boolean, origin: ScheduledCloudOrigin = "kaizen-daily",
  ): Promise<unknown> {
    if (scope.subsidiaryId !== null) throw new Error("cloud_target_not_found");
    return this.submitWork(scope, input, origin, mayLaunch);
  }

  private async submitWork(scope: CloudScope, input: CloudWorkInput, origin?: ScheduledCloudOrigin, mayLaunch?: () => boolean): Promise<unknown> {
    const environment = await this.target(scope, input.targetId);
    if (origin && (!this.isKaizenTarget(environment) || input.work)) {
      throw new Error("cloud_target_not_found");
    }
    await this.ports.authorizeTask(input.taskReference, scope, true);
    if (environment.provider === "colab") throw new Error("cloud_colab_owner_required");
    if (!input.computeReason.trim() || !input.llmReason.trim()) throw new Error("cloud_work_evidence_missing");
    const store = this.store(scope);
    // Avoid even a preflight after an ambiguous submission. The same ID is never replayed.
    const existing = await store.readRecord(input.attemptId, "intent");
    if (existing) {
      const run = existing as StoredRun;
      if (!this.sameRequest(run, input, origin)) {
        throw new Error("cloud_attempt_conflict");
      }
      return this.status(scope, input.attemptId);
    }
    const target = resolveCloudWork(environment, input.work);
    if (!cloudTargetReady(target, this.ports.env, this.ports.now())) throw new Error("cloud_target_not_ready");
    await this.ports.preflight(target);
    if (mayLaunch && !mayLaunch()) throw new Error("cloud_kaizen_stopped");
    const request: StoredRun = {
      attemptId: input.attemptId, targetId: target.id, transferMode: target.transferMode, taskReference: input.taskReference,
      work: CloudWorkPlanSchema.parse(Object.fromEntries(Object.keys(CloudWorkPlanSchema.shape).map(key => [key, target[key as keyof CloudTarget]]))),
      inputWorkHash: hash(JSON.stringify(input.work ? CloudWorkPlanSchema.parse(input.work) : null)),
      computeReason: input.computeReason, llmReason: input.llmReason, createdAt: this.ports.now(),
      requestFingerprint: requestFingerprint([scope, input.attemptId, input.taskReference, configurationKey(target),
        input.instruction, input.computeReason, input.llmReason, input.gpuRequired, ...(origin ? [origin] : [])]),
      configurationKey: configurationKey(target), provider: target.provider, environmentId: target.environmentId,
      sourceRevision: target.sourceRevision, instruction: input.instruction,
      eligibility: { repositoryBytes: target.repositoryBytes, environmentPreparable: target.environmentPreparable,
        requiresLargeProjectClone: target.requiresLargeProjectClone, computeIntensiveArtifactGeneration: !origin, requiresLlmGuidance: true },
      ...(origin ? { eligibilityOrigin: origin } : {}),
      standardHosted: target.standardHosted, gpuRequired: input.gpuRequired, gpuVerified: target.gpuVerified,
      sourceAvailable: true, artifactTransferReady: true,
    };
    const receipt = await submitCloudWork(request, store, this.ports.adapter(target, input.attemptId));
    if (receipt.state === "already_reserved" && !this.sameRequest(await this.run(scope, input.attemptId), input, origin)) {
      throw new Error("cloud_attempt_conflict");
    }
    return this.status(scope, input.attemptId);
  }

  private sameRequest(run: StoredRun, input: CloudWorkInput, origin?: ScheduledCloudOrigin): boolean {
    return run.eligibilityOrigin === origin && run.targetId === input.targetId && run.taskReference === input.taskReference
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
    const receipt = await this.receipt(store, attemptId);
    const reconciliation = await store.readRecord(attemptId, "reconciliation");
    const verified = await store.readRecord(attemptId, "verified");
    const observation = (await store.readRecord(attemptId, "provider-terminal")
      ?? await store.readRecord(attemptId, "provider-running")) as { state: ProviderTerminal; at: number } | null;
    const workerReport = scope.subsidiaryId === null
      ? await this.ports.workerReport?.(run.targetId, attemptId) ?? null : null;
    return { attemptId, taskReference: run.taskReference, provider: run.provider, targetId: run.targetId, transferMode: run.transferMode ?? "s3",
      ...executionEvidence(receipt, observation?.state ?? "unknown", verified, "pending", "not_applicable", workerReport),
      providerObservedAt: observation?.at ?? null, reconciliation, verified,
      state: verified ? (run.transferMode === "git" ? (verified as { state: string }).state : "artifacts_verified")
        : (receipt as { state?: string } | null)?.state ?? "submission_unknown" };
  }

  private async receipt(store: FileCloudSubmissionStore, attemptId: string): Promise<CloudReceipt> {
    return (await store.readRecord(attemptId, "receipt") ?? await store.readRecord(attemptId, "receipt-intermediate")
      ?? { state: "submission_unknown" }) as CloudReceipt;
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
      && (provider === "codex-cloud" ? /^task_[A-Za-z0-9_-]+$/ : /^(?:session|cse)_[A-Za-z0-9_-]+$/).test(value)
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

  async reconcile(scope: CloudScope, attemptId: string, remoteId?: string): Promise<unknown> {
    const run = await this.run(scope, attemptId), store = this.store(scope);
    const receipt = await this.receipt(store, attemptId);
    const prior = await store.readRecord(attemptId, "reconciliation") as { remoteId: string } | null;
    if (remoteId && ((receipt.remoteId && receipt.remoteId !== remoteId) || (prior && prior.remoteId !== remoteId))) {
      throw new Error("cloud_attempt_conflict");
    }
    if (prior) return this.status(scope, attemptId);
    const target = remoteId || receipt.remoteId ? undefined : await this.checkedTarget(scope, run);
    const adapter = target ? this.ports.adapter(target, attemptId) : undefined;
    const matched = remoteId ?? receipt.remoteId ?? (await adapter?.reconcile?.(this.identity(run, receipt)))?.remoteId;
    if (!matched) return this.status(scope, attemptId);
    if (!(run.provider === "codex-cloud" ? /^task_[A-Za-z0-9_-]+$/ : /^(?:session|cse)_[A-Za-z0-9_-]+$/).test(matched) || matched.length > 200) {
      throw new Error("invalid_cloud_remote_id");
    }
    try {
      await store.writeRecord(attemptId, "reconciliation", { remoteId: matched, source: remoteId ? "operator_observation" : "provider_receipt" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await store.readRecord(attemptId, "reconciliation") as { remoteId?: string } | null;
      if (raced?.remoteId !== matched) throw new Error("cloud_attempt_conflict");
    }
    return this.status(scope, attemptId);
  }

  async observe(scope: CloudScope, attemptId: string): Promise<unknown> {
    const run = await this.run(scope, attemptId), store = this.store(scope);
    const target = await this.checkedTarget(scope, run), adapter = this.ports.adapter(target, attemptId);
    const receipt = await this.receipt(store, attemptId);
    const reconciliation = await store.readRecord(attemptId, "reconciliation") as { remoteId: string } | null;
    const identity = this.identity(run, receipt.state !== "submission_unknown" || receipt.remoteId || !reconciliation
      ? receipt : { ...receipt, remoteId: reconciliation.remoteId });
    const providerTerminal = await adapter.observe?.(identity) ?? "unknown";
    if (providerTerminal !== "unknown") {
      try {
        await store.writeRecord(attemptId, providerTerminal === "running" ? "provider-running" : "provider-terminal",
          { state: providerTerminal, at: this.ports.now() });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return this.status(scope, attemptId);
  }

  private identity(run: StoredRun, receipt: CloudReceipt): ExecutionIdentity {
    return { receipt, requestFingerprint: run.requestFingerprint ?? "" };
  }

  private async checkedTarget(scope: CloudScope, run: StoredRun): Promise<CloudTarget> {
    const target = resolveCloudWork(await this.target(scope, run.targetId), run.work);
    if ((!run.transferMode && target.transferMode !== "s3")
      || configurationKey(target, !run.transferMode) !== run.configurationKey) throw new Error("cloud_target_configuration_changed");
    return target;
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
    const target = await this.checkedTarget(scope, run);
    if (run.transferMode === "git") {
      if (!this.ports.collectGit) throw new Error("cloud_git_collection_unavailable");
      // CC-CLOUD-DRIVE-04: side-effect-free Drive verification precedes Git promotion and its review submission.
      const driveNames = driveArtifactNames(target);
      const drive = driveNames.length ? await this.collectArtifacts(scope, attemptId, run, target, driveNames) : null;
      const git = await this.ports.collectGit(target, attemptId);
      await store.writeRecord(attemptId, "verified", drive ? { ...(git as object), artifacts: drive.artifacts } : git);
      return this.status(scope, attemptId);
    }
    const verified = await this.collectArtifacts(scope, attemptId, run, target, target.expectedNames);
    await store.writeRecord(attemptId, "verified", verified);
    return this.status(scope, attemptId);
  }

  /** Saves verified bytes; the caller writes the verified marker last, so partial collection is never downloadable. */
  private async collectArtifacts(scope: CloudScope, attemptId: string, run: StoredRun, target: CloudTarget,
    expectedNames: string[]): Promise<ReturnType<typeof verifyCloudArtifacts>> {
    const adapter = this.ports.adapter(target, attemptId);
    const result = adapter.collect
      ? await adapter.collect(this.identity(run, await this.receipt(this.store(scope), attemptId)))
      : await this.ports.collect(target, attemptId);
    const verified = verifyCloudArtifacts({ ...result, attemptId, sourceRevision: run.sourceRevision,
      expectedNames, maxTotalBytes: target.maxArtifactBytes });
    const directory = join(this.root(scope), `${attemptId}.artifacts`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const artifact of verified.artifacts) {
      await writeFile(join(directory, artifact.name), result.received.get(artifact.name)!, { mode: 0o600 });
    }
    return verified;
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
