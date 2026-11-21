import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { ColabAdapter, ColabAllocationRefused, type ColabAllocation } from "./colab-adapter.js";
import { ColabJournal } from "./colab-journal.js";
import { colabAdmission } from "./colab-policy.js";
import { colabRunStatus, isSiteColabRun, type ColabOwner, type ColabRun, type ColabStart } from "./colab-run.js";
import { requestFingerprint } from "./execution-adapter.js";
import type { DriveCloudArtifacts } from "./drive-artifacts.js";
import type { ColabReport } from "./colab-result.js";
import type { ColabBinding, LegacyColabBinding } from "./colab-config.js";
import { ColabSiteRunner } from "./colab-site-runner.js";
import { collectColabSiteArtifacts } from "./colab-site-artifacts.js";
import type { ColabSiteTransport } from "./colab-site-excubitor.js";
import type { CloudEnvironment } from "./runtime-config.js";
import type { CloudScope } from "./runtime-service.js";

interface Ports {
  targets(scope: CloudScope): Promise<CloudEnvironment[]>;
  authorizeTask(reference: string, scope: CloudScope, active?: boolean): Promise<void>;
  bindingReady(binding: ColabBinding): boolean;
  readProgram(repoPath: string, revision: string, binding: LegacyColabBinding): Promise<string>;
  adapter(run: ColabRun, allocation: ColabAllocation, signal: AbortSignal): ColabAdapter;
  site?: ColabSiteTransport;
  drive(run: ColabRun): DriveCloudArtifacts | undefined;
  now(): number;
  delay?(ms: number, signal: AbortSignal): Promise<void>;
  uuid?(): string;
}

type Work = { key: string; task: Promise<void>; stop(reason: NonNullable<ColabRun["stopReason"]>): void };
const RETRY_MS = 10_000;

function scopeKey(scope: CloudScope, owner: ColabOwner): string {
  return requestFingerprint([scope.repositoryKey, scope.subsidiaryId, owner.organizationId, owner.userId]);
}

function owns(binding: ColabBinding, owner: ColabOwner): boolean {
  return binding.ownerId === owner.userId && binding.organizationId === owner.organizationId;
}

export class ColabService {
  private readonly owner = randomUUID();
  private work: Work | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private readonly site: ColabSiteRunner | undefined;

  constructor(private readonly journal: ColabJournal, private readonly ports: Ports) {
    if (ports.site) this.site = new ColabSiteRunner(journal, ports.site, this.owner, ports.now);
  }

  startRecovery(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => { void this.recover().catch(() => { /* Resource remains reserved for the next recovery scan. */ }); }, RETRY_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.work?.stop("shutdown");
    await this.work?.task;
    this.journal.close();
  }

  async targets(scope: CloudScope, owner: ColabOwner) {
    const readiness = new Map<string, ReturnType<ColabSiteTransport["readiness"]>>();
    return Promise.all((await this.ports.targets(scope)).flatMap(target => {
      const binding = target.colab;
      if (target.provider !== "colab" || !binding || !owns(binding, owner)) return [];
      return [this.targetStatus(target, binding, readiness)];
    }));
  }

  private async targetStatus(target: CloudEnvironment, binding: ColabBinding,
    readiness: Map<string, ReturnType<ColabSiteTransport["readiness"]>>) {
    const common = { id: target.id, label: target.label, destination: binding.destination, maxSeconds: binding.maxSeconds };
    if (!binding.site) return { ...common, gpu: binding.runtimeSpec.accelerator, ready: this.ports.bindingReady(binding) };
    const peer = binding.site.peerId;
    if (!readiness.has(peer) && this.site) readiness.set(peer, this.site.transport.readiness(peer));
    const probe = readiness.get(peer);
    const connection = probe ? await probe : "cloud_colab_site_unreachable";
    const reason = connection ?? (this.ports.bindingReady(binding) ? null : "cloud_colab_credentials_unavailable");
    return { ...common, gpu: binding.site.gpu, ready: reason === null, transport: "excubitor-site" as const, reason };
  }

  async start(scope: CloudScope, owner: ColabOwner, input: ColabStart) {
    await this.ports.authorizeTask(input.taskReference, scope, true);
    const ownerScope = scopeKey(scope, owner);
    const key = requestFingerprint([ownerScope, input.attemptId]);
    const existing = this.journal.get(key);
    if (existing) return this.checkRepeated(existing, input);
    const target = (await this.ports.targets(scope)).find(item => item.id === input.targetId && item.provider === "colab");
    const binding = target?.colab;
    if (!target?.sourceRevision || !binding || !owns(binding, owner)
      || !colabAdmission({ ownerApproved: input.ownerApproved, evidence: input.evidence, ownerDestination: binding.destination })) {
      throw new Error("cloud_colab_owner_or_classification_required");
    }
    const units = input.seconds / 60 * binding.usageUnitsPerMinute;
    if (!Number.isInteger(input.seconds) || input.seconds < 30 || input.seconds > binding.maxSeconds || units > binding.maxUsageUnits) {
      throw new Error("cloud_colab_usage_limit");
    }
    if (!this.ports.bindingReady(binding)) throw new Error("cloud_colab_credentials_unavailable");
    if (binding.site) {
      if (!this.site) throw new Error("cloud_colab_site_unreachable");
      const unavailable = await this.site.transport.readiness(binding.site.peerId);
      if (unavailable) throw new Error(unavailable);
    }
    const program = binding.site ? undefined : await this.ports.readProgram(target.repoPath, target.sourceRevision, binding);
    if (this.closing) throw new Error("cloud_colab_unavailable");
    const now = this.ports.now(), requestId = (this.ports.uuid ?? randomUUID)();
    const run: ColabRun = { key, scope, requestFingerprint: requestFingerprint([ownerScope, input.taskReference, input.targetId,
      target.sourceRevision, binding, input.seconds, input.evidence.code, input.evidence.data, input.evidence.destination]),
      binding, attemptId: input.attemptId, taskReference: input.taskReference, targetId: input.targetId, sourceRevision: target.sourceRevision,
      requestId, runtimeName: `runtimes/cc-${requestId}`, createdAt: now, deadlineAt: now + input.seconds * 1000,
      estimatedUnits: units, receipt: { state: "submission_unknown", requestId }, allocation: "unattempted",
      providerTerminal: "unknown", workerReport: null, verified: null, quality: "pending", resourceRelease: "unknown",
      stopReason: null, error: null, ...(binding.site ? { site: { stopRequested: false, cancelSent: false } } : {}) };
    if (this.work) throw new Error("cloud_colab_busy");
    const reserve = this.journal.reserve(run, ownerScope, this.owner, now);
    if (reserve === "busy") throw new Error("cloud_colab_busy");
    if (reserve === "existing") {
      const prior = this.journal.get(key);
      if (!prior) throw new Error("cloud_journal_incomplete");
      return this.checkRepeated(prior, input);
    }
    const accepted = colabRunStatus(run);
    void this.launch(run, { initial: true, program });
    return accepted;
  }

  async list(scope: CloudScope, owner: ColabOwner, refreshSite = false) {
    const result = [];
    for (const run of this.journal.list(scopeKey(scope, owner))) {
      try {
        await this.ports.authorizeTask(run.taskReference, scope);
        if (refreshSite && run.site?.receipt && run.resourceRelease !== "released") {
          await this.recover({ key: run.key, refresh: true });
        }
        result.push(colabRunStatus(this.journal.get(run.key) ?? run));
      } catch { /* Match the task scope check used when listing cloud batches. */ }
    }
    return result;
  }

  async stop(scope: CloudScope, owner: ColabOwner, attemptId: string) {
    const run = await this.ownedRun(scope, owner, attemptId);
    if (run.site) {
      const requested = this.journal.requestSiteStop(run.key);
      if (requested.resourceRelease !== "released" && !this.work) {
        void this.recover({ key: run.key }).catch(() => { /* The stop intent remains in the journal. */ });
      }
      return colabRunStatus(requested);
    }
    if (this.work?.key === run.key) this.work.stop("cancelled");
    else if (run.resourceRelease !== "released") await this.recover();
    return colabRunStatus(this.journal.get(run.key) ?? run);
  }

  async collect(scope: CloudScope, owner: ColabOwner, attemptId: string) {
    const run = await this.ownedRun(scope, owner, attemptId);
    if (run.verified) return colabRunStatus(run);
    if (isSiteColabRun(run) && this.site) {
      const verified = await collectColabSiteArtifacts(run, this.site.transport,
        report => this.journal.recordSiteReport(run.key, report), () => this.ports.drive(run));
      return colabRunStatus(this.journal.verify(run.key, verified));
    }
    if (!run.workerReport || run.resourceRelease !== "released") throw new Error("cloud_colab_collection_unready");
    const verified = await this.verifyReport(run, run.workerReport, AbortSignal.timeout(30_000));
    return colabRunStatus(this.journal.verify(run.key, verified));
  }

  async quality(scope: CloudScope, owner: ColabOwner, attemptId: string, quality: "accepted" | "rejected") {
    const run = await this.ownedRun(scope, owner, attemptId);
    return colabRunStatus(this.journal.quality(run.key, quality));
  }

  async recover(options: { key?: string; refresh?: boolean } = {}): Promise<void> {
    if (this.closing || this.work) return;
    const run = this.journal.claimRecovery(this.owner, this.ports.now(), options.key);
    if (!run) return;
    await this.launch(run, { refresh: options.refresh });
  }

  private async ownedRun(scope: CloudScope, owner: ColabOwner, attemptId: string): Promise<ColabRun> {
    const run = this.journal.get(requestFingerprint([scopeKey(scope, owner), attemptId]));
    if (!run) throw new Error("cloud_attempt_not_found");
    await this.ports.authorizeTask(run.taskReference, scope);
    return run;
  }

  private checkRepeated(run: ColabRun, input: ColabStart) {
    if (run.targetId !== input.targetId || run.taskReference !== input.taskReference
      || run.deadlineAt - run.createdAt !== input.seconds * 1000
      || !colabAdmission({ ownerApproved: input.ownerApproved, evidence: input.evidence, ownerDestination: run.binding.destination })) {
      throw new Error("cloud_attempt_conflict");
    }
    return colabRunStatus(run);
  }

  private launch(run: ColabRun, options: { program?: string; initial?: boolean; refresh?: boolean }): Promise<void> {
    const { program } = options;
    if (isSiteColabRun(run)) {
      const task = Promise.resolve().then(() => this.site?.advance(run, !!options.initial, !!options.refresh))
        .catch(() => { /* The durable intent stays reserved for a subsequent read. */ })
        .finally(() => { this.work = undefined; });
      // The site owns deadline and cleanup. Wait for the current receipt write before closing the journal.
      this.work = { key: run.key, task, stop() {} };
      return task;
    }
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      try {
        if (this.journal.renew(run, this.owner, this.ports.now())) return;
      } catch { /* Stop starting new effects when the journal is unavailable. */ }
      controller.abort();
    }, RETRY_MS);
    heartbeat.unref();
    const stop: Work["stop"] = reason => {
      run.stopReason ??= reason;
      controller.abort();
    };
    const deadline = program === undefined ? undefined
      : setTimeout(() => stop("deadline"), Math.max(0, run.deadlineAt - this.ports.now()));
    deadline?.unref();
    const task = Promise.resolve().then(async () => {
      try {
        if (program !== undefined) await this.execute(run, program, controller.signal);
        else run.stopReason ??= "interrupted";
      } finally {
        clearTimeout(deadline);
        if (this.journal.renew(run, this.owner, this.ports.now())) await this.release(run);
      }
    }).catch(() => { /* The durable active claim permits cleanup after journal or transport failure. */ })
      .finally(() => { clearInterval(heartbeat); this.work = undefined; });
    this.work = { key: run.key, task, stop };
    return task;
  }

  private save(run: ColabRun): void { this.journal.save(run, this.owner, this.ports.now()); }

  private adapter(run: ColabRun, signal: AbortSignal): [ColabAdapter, ColabAllocation] {
    if (run.binding.site) throw new Error("cloud_colab_unavailable");
    const allocation = { name: run.runtimeName, requestId: run.requestId, runtimeSpec: run.binding.runtimeSpec };
    return [this.ports.adapter(run, allocation, signal), allocation];
  }

  private async execute(run: ColabRun, program: string, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const [adapter, allocation] = this.adapter(run, signal);
      const drive = this.ports.drive(run);
      const uploads = await drive?.checkpointUploads(run.requestId, signal) ?? [];
      const inputs = Buffer.from(JSON.stringify({ attemptId: run.attemptId, sourceRevision: run.sourceRevision, uploads }), "utf8").toString("base64");
      const code = `import base64 as _cc_b64, json as _cc_json\nCC_CLOUD_INPUT = _cc_json.loads(_cc_b64.b64decode("${inputs}"))\n${program}`;
      signal.throwIfAborted();
      run.allocation = "uncertain";
      this.save(run);
      run.receipt = await adapter.submit(allocation, async receipt => { run.receipt = receipt; this.save(run); });
      this.save(run);
      while (run.receipt.state !== "submitted") {
        signal.throwIfAborted();
        run.receipt = await adapter.reconcile(run);
        if (run.receipt.state !== "submitted") await (this.ports.delay ?? ((ms, s) => wait(ms, undefined, { signal: s })))(2000, signal);
      }
      this.save(run);
      run.providerTerminal = await adapter.observe(run);
      this.save(run);
      signal.throwIfAborted();
      run.providerTerminal = await adapter.execute(code);
      this.save(run);
      run.workerReport = await adapter.collect();
      this.save(run);
      run.verified = await this.verifyReport(run, run.workerReport, signal, drive);
      this.save(run);
    } catch (error) {
      if (error instanceof ColabAllocationRefused) {
        run.allocation = "refused";
        run.providerTerminal = "failed";
        run.error = "cloud_colab_allocation_refused";
      } else if (!run.stopReason) {
        run.error = run.workerReport ? "cloud_colab_artifacts_unverified" : "cloud_colab_execution_unconfirmed";
      }
    }
  }

  private async verifyReport(run: ColabRun, report: ColabReport, signal: AbortSignal, drive?: DriveCloudArtifacts) {
    if (!report.checkpoints.length) return { report, checkpoints: [] };
    const artifacts = drive ?? this.ports.drive(run);
    if (!artifacts) throw new Error("cloud_colab_collection_unready");
    return { report, checkpoints: await artifacts.verifyCheckpoints(run.requestId, report.checkpoints, signal) };
  }

  private async release(run: ColabRun): Promise<void> {
    try {
      if (run.allocation === "unattempted") {
        run.resourceRelease = "released";
      } else {
        const [adapter] = this.adapter(run, AbortSignal.timeout(45_000));
        if (run.allocation !== "refused" && run.receipt.state !== "submitted") {
          try { run.receipt = await adapter.reconcile(run); }
          catch (error) {
            if (error instanceof ColabAllocationRefused) run.allocation = "refused";
            // A transient operation lookup can fail while the exact runtime name still resolves.
          }
        }
        run.resourceRelease = await adapter.release(run, run.allocation === "refused");
        if (run.stopReason && run.resourceRelease === "released" && run.providerTerminal === "running") {
          run.providerTerminal = "cancelled";
        }
      }
    } catch { run.resourceRelease = "unknown"; }
    this.save(run);
  }
}
