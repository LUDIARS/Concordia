import type { AwsBinding } from "./aws-config.js";
import type { AwsExcubitor } from "./aws-excubitor.js";
import type { AwsJob } from "./aws-excubitor-schema.js";
import { AwsJournal } from "./aws-journal.js";
import { awsAdmission, matchAwsJob } from "./aws-policy.js";
import { AWS_ARTIFACT_ATTEMPT_KEY, type AwsRequest } from "./aws-request.js";
import { awsRunStatus, type AwsOwner, type AwsRun } from "./aws-run.js";
import type { ColabCheckpoint } from "./drive-artifacts.js";
import { requestFingerprint } from "./execution-adapter.js";
import type { CloudScope } from "./runtime-service.js";

type Actor = { sessionId: string; owner?: AwsOwner };
interface Ports {
  ex: AwsExcubitor;
  bindings(scope: CloudScope): Promise<AwsBinding[]>;
  authorizeTask(reference: string, scope: CloudScope, requireActive?: boolean): Promise<void>;
  artifactsReady(binding: AwsBinding): boolean;
  collect(run: AwsRun): Promise<ColabCheckpoint[]>;
  now(): number;
}
type Observation = NonNullable<ReturnType<AwsJournal["get"]>>;
const PROPOSAL_TTL_MS = 15 * 60_000;

function scopeKey(scope: CloudScope): string {
  return requestFingerprint([scope.repositoryKey, scope.subsidiaryId]);
}

function runKey(scope: CloudScope, attemptId: string): string {
  return requestFingerprint([scopeKey(scope), attemptId]);
}

function fingerprint(scope: CloudScope, input: AwsRequest): string {
  return requestFingerprint([scopeKey(scope), input.taskReference, input.targetId, input.runner, Date.parse(input.deadline),
    input.evidence.destination, input.evidence.code, input.evidence.data, Object.entries(input.inputs).sort()]);
}

function owns(owner: AwsOwner, actor: Actor): boolean {
  return actor.owner?.userId === owner.userId && actor.owner.organizationId === owner.organizationId;
}

export class AwsService {
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly journal: AwsJournal, private readonly ports: Ports) {}

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending);
    this.journal.close();
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("cloud_aws_unavailable");
    const pending = operation();
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  private async bindings(scope: CloudScope, actor: Actor): Promise<AwsBinding[]> {
    return (await this.ports.bindings(scope)).filter(binding => !actor.owner
      || owns({ userId: binding.ownerId, organizationId: binding.organizationId }, actor));
  }

  async targets(scope: CloudScope, actor: Actor) {
    return this.execute(async () => {
      const bindings = await this.bindings(scope, actor);
      if (!bindings.length) return [];
      const listed = await this.ports.ex.targets();
      return listed.targets.flatMap(target => {
        const runners = bindings.flatMap(binding => {
          if (binding.targetId !== target.id) return [];
          const runner = target.runners.find(item => item.id === binding.runner);
          if (!runner) return [];
          return [{ id: runner.id, destination: binding.destination,
            inputKeys: runner.inputKeys.filter(key => key !== AWS_ARTIFACT_ATTEMPT_KEY),
            maxSeconds: Math.floor(Math.min(target.maxRuntimeSeconds, binding.maxSeconds, binding.maxUsageUnits / binding.usageUnitsPerMinute * 60)),
            ready: listed.credentials.configured && this.ports.artifactsReady(binding)
              && (!binding.drive || runner.inputKeys.includes(AWS_ARTIFACT_ATTEMPT_KEY)) }];
        });
        return runners.length ? [{ id: target.id, name: target.name, kind: target.kind, runners }] : [];
      });
    });
  }

  async propose(scope: CloudScope, sessionId: string, input: AwsRequest) {
    return this.execute(async () => {
      await this.ports.authorizeTask(input.taskReference, scope, true);
      const key = runKey(scope, input.attemptId);
      const existing = this.journal.get(key)?.value;
      if (existing) {
        if (existing.sessionId !== sessionId || existing.requestFingerprint !== fingerprint(scope, input)) {
          throw new Error("cloud_attempt_conflict");
        }
        return awsRunStatus(existing);
      }
      if (!(await this.bindings(scope, { sessionId })).some(binding =>
        binding.targetId === input.targetId && binding.runner === input.runner && binding.destination === input.evidence.destination)) {
        throw new Error("cloud_aws_classification");
      }
      const now = this.ports.now();
      const expiresAt = Math.min(Date.parse(input.deadline), now + PROPOSAL_TTL_MS);
      if (!(expiresAt > now)) throw new Error("cloud_aws_deadline");
      const proposal = this.journal.propose({ key, scopeKey: scopeKey(scope),
        sessionId, request: input, expiresAt }, now);
      if (proposal.sessionId !== sessionId || fingerprint(scope, proposal.request) !== fingerprint(scope, input)) {
        throw new Error("cloud_attempt_conflict");
      }
      return { attemptId: input.attemptId, status: "human_approval_required", expiresAt: proposal.expiresAt };
    });
  }

  async proposals(scope: CloudScope, actor: { sessionId: string; owner: AwsOwner }) {
    return this.execute(async () => {
      const bindings = await this.bindings(scope, actor);
      return this.journal.proposals(scopeKey(scope), actor.sessionId, this.ports.now())
        .filter(({ request }) => bindings.some(binding => binding.targetId === request.targetId && binding.runner === request.runner))
        .map(({ request, expiresAt }) => ({ ...request, expiresAt }));
    });
  }

  async start(scope: CloudScope, actor: { sessionId: string; owner: AwsOwner }, input: AwsRequest, authorize: () => Promise<void>,
    fromProposal = false) {
    return this.execute(async () => {
      const key = runKey(scope, input.attemptId);
      const requestHash = fingerprint(scope, input);
      await this.ports.authorizeTask(input.taskReference, scope, true);
      const previous = this.journal.get(key);
      if (previous) return this.repeated(previous.value, actor, requestHash);
      const proposal = this.journal.proposal(key, this.ports.now());
      if (proposal && (proposal.sessionId !== actor.sessionId || fingerprint(scope, proposal.request) !== requestHash)) {
        throw new Error("cloud_attempt_conflict");
      }
      if (fromProposal && !proposal) throw new Error("cloud_aws_proposal_expired");
      const binding = (await this.bindings(scope, actor)).find(item => item.targetId === input.targetId && item.runner === input.runner);
      if (!binding) throw new Error("cloud_aws_classification");
      const listed = await this.ports.ex.targets();
      const target = listed.targets.find(item => item.id === input.targetId);
      const runner = target?.runners.find(item => item.id === input.runner);
      if (!target || !runner || (target.kind === "fargate" && !runner.container)) throw new Error("cloud_target_not_found");
      if (!listed.credentials.configured || !this.ports.artifactsReady(binding)) throw new Error("cloud_aws_unavailable");
      const requestId = "cc-" + key;
      const inputs = binding.drive ? { ...input.inputs, [AWS_ARTIFACT_ATTEMPT_KEY]: requestId } : input.inputs;
      if (Object.keys(inputs).some(name => !runner.inputKeys.includes(name))) throw new Error("cloud_aws_invalid_inputs");
      await authorize();
      if (this.closing) throw new Error("cloud_aws_unavailable");
      const now = this.ports.now(), deadline = Date.parse(input.deadline);
      const admission = awsAdmission({ approved: true, ...input.evidence, expectedDestination: binding.destination,
        now, deadline, maxSeconds: Math.min(target.maxRuntimeSeconds, binding.maxSeconds),
        unitsPerMinute: binding.usageUnitsPerMinute, maxUnits: binding.maxUsageUnits });
      if (admission !== "allowed") throw new Error("cloud_aws_" + admission);
      if (fromProposal && (!proposal || proposal.expiresAt <= now)) throw new Error("cloud_aws_proposal_expired");
      const run: AwsRun = { key, scopeKey: scopeKey(scope), sessionId: actor.sessionId,
        owner: { userId: actor.owner.userId, organizationId: actor.owner.organizationId },
        attemptId: input.attemptId, taskReference: input.taskReference, requestFingerprint: requestHash,
        requestId, targetId: target.id, runner: runner.id, kind: target.kind, container: runner.container,
        drive: binding.drive, createdAt: now, deadline: new Date(deadline).toISOString() };
      if (!this.journal.reserve(run)) return this.repeated(this.journal.get(key)!.value, actor, requestHash);
      // The durable intent survives lost replies and process shutdown. A second start can only inspect it.
      const response = await this.ports.ex.submit({ target_id: run.targetId, job_id: requestId,
        runner: run.runner, inputs, deadline: run.deadline }).catch(() => undefined);
      if (response && "refused" in response) {
        this.journal.update(key, value => value.job ? value : { ...value, refusal: response.refused });
      } else if (response && matchAwsJob([response.job], run) && response.job.kind === run.kind) {
        this.journal.update(key, value => value.job ? value : { ...value, job: response.job, issue: undefined });
      }
      return awsRunStatus(this.journal.get(key)!.value);
    });
  }

  private repeated(run: AwsRun, actor: Actor, requestHash: string) {
    if (!owns(run.owner, actor) || run.requestFingerprint !== requestHash) throw new Error("cloud_attempt_conflict");
    return awsRunStatus(run);
  }

  private canSee(run: AwsRun, actor: Actor): boolean {
    return actor.owner ? owns(run.owner, actor) : run.sessionId === actor.sessionId;
  }

  private async find(scope: CloudScope, actor: Actor, id: string): Promise<Observation> {
    const current = this.journal.get(runKey(scope, id));
    if (!current || !this.canSee(current.value, actor)) throw new Error("cloud_attempt_not_found");
    await this.ports.authorizeTask(current.value.taskReference, scope);
    return current;
  }

  async list(scope: CloudScope, actor: Actor) {
    return this.execute(async () => {
      const visible = this.journal.list(scopeKey(scope)).filter(run => this.canSee(run, actor));
      const results = await Promise.all(visible.slice(0, 50).map(async run => {
        await this.ports.authorizeTask(run.taskReference, scope);
        return awsRunStatus(run);
      }));
      return results;
    });
  }

  private record(current: Observation, job: AwsJob): void {
    const run = current.value;
    if (!matchAwsJob([job], run) || job.kind !== run.kind || (run.job && run.job.operation_id !== job.operation_id)) {
      throw new Error("cloud_aws_observation_unavailable");
    }
    this.journal.recordObservation(current, job);
  }

  private async observe(current: Observation): Promise<Observation> {
    const run = current.value;
    if (awsRunStatus(run).resourceRelease === "released") return current;
    try {
      const job = run.job ? await this.ports.ex.observe(run.job.operation_id) : await this.ports.ex.reconcile(run);
      if (job) this.record(current, job);
    } catch {
      this.journal.recordIssue(current, "cloud_aws_observation_unavailable");
    }
    return this.journal.get(run.key)!;
  }

  async status(scope: CloudScope, actor: Actor, id: string) {
    return this.execute(async () => {
      if (!actor.owner) {
        const proposal = this.journal.proposal(runKey(scope, id), this.ports.now());
        if (proposal?.sessionId === actor.sessionId) {
          await this.ports.authorizeTask(proposal.request.taskReference, scope);
          return { attemptId: id, status: "human_approval_required", expiresAt: proposal.expiresAt };
        }
      }
      return awsRunStatus((await this.observe(await this.find(scope, actor, id))).value);
    });
  }

  async stop(scope: CloudScope, actor: Actor, id: string) {
    return this.execute(async () => {
      let current = await this.observe(await this.find(scope, actor, id));
      if (awsRunStatus(current.value).resourceRelease === "released") return awsRunStatus(current.value);
      current = this.journal.update(current.value.key, value => ({ ...value, stopRequested: true }));
      const job = current.value.job;
      if (!job) return awsRunStatus(current.value);
      try {
        if (job.release === "pending") this.record(current, await this.ports.ex.cancel(job.operation_id));
      } catch {
        this.journal.recordIssue(current, "cloud_aws_stop_unconfirmed");
      }
      return awsRunStatus(this.journal.get(current.value.key)!.value);
    });
  }

  async collect(scope: CloudScope, actor: { sessionId: string; owner: AwsOwner }, id: string) {
    return this.execute(async () => {
      const { value: run } = await this.observe(await this.find(scope, actor, id));
      if (run.artifacts) return awsRunStatus(run);
      if (!run.drive || !run.job || run.job.release !== "confirmed") throw new Error("cloud_artifact_unavailable");
      const artifacts = await this.ports.collect(run);
      return awsRunStatus(this.journal.update(run.key, value => ({ ...value, artifacts: value.artifacts ?? artifacts })).value);
    });
  }

  async quality(scope: CloudScope, actor: { sessionId: string; owner: AwsOwner }, id: string, quality: "accepted" | "rejected") {
    return this.execute(async () => {
      const { value: run } = await this.find(scope, actor, id);
      return awsRunStatus(this.journal.update(run.key, value => {
        if (!value.artifacts || (value.quality && value.quality !== quality)) throw new Error("cloud_aws_quality_unready");
        return { ...value, quality };
      }).value);
    });
  }
}
