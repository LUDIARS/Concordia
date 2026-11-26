/**
 * PR フック → Praeforma の仕様下書き、 と `spec.*` メソッド (契約 v1 §4d)。
 *
 * - 受け口 (GitHub webhook、 署名検証済み) は対象 PR をジョブに積むだけ (enqueue)。
 * - Hub の worker がジョブを 1 件ずつ取り出し、 差分を取って Praeforma に draft の断片を作り、
 *   仕様の再構築案を頼み、 PR に「下書きができた」とコメントする。
 * - spec.review は Praeforma の採否 API (reconstructions/:rid/decide) への中継。 本人の操作として記録する。
 *
 * @implements spec/feature/glab-unity-hub.md §4d (GUH-SPEC)
 */

import { randomUUID } from "node:crypto";
import { HubError } from "../domain/protocol.js";
import {
  buildFragmentContent,
  findSpecRepo,
  reconstructionDecision,
  specDraftComment,
  specSourceEventId,
  statusFromDisposition,
  type SpecRepoBinding,
} from "../domain/spec-draft.js";
import type { HubPayload } from "../domain/methods.js";
import type { AuditLog, Clock, IssuePort, PraeformaSpecPort, SpecDraftRecord, SpecDraftStore, SpecJob } from "./ports.js";
import type { MethodContext } from "./method-context.js";

export interface SpecDraftServiceDeps {
  readonly store: SpecDraftStore;
  readonly praeforma: PraeformaSpecPort;
  readonly github: IssuePort;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly specRepos: readonly SpecRepoBinding[];
  readonly log?: (message: string) => void;
}

export interface SpecListItem {
  readonly id: string;
  readonly title: string;
  readonly status: SpecDraftRecord["status"];
  readonly prUrl: string;
  readonly updatedAt: string;
}

export class HubSpecDraftService {
  constructor(private readonly deps: SpecDraftServiceDeps) {}

  /** 積まれたジョブを 1 件処理する。 処理したら true。 */
  async processNext(): Promise<boolean> {
    const job = this.deps.store.claimJob(this.now());
    if (!job) return false;
    try {
      await this.draft(job);
      this.deps.store.finishJob(job.jobId, this.now(), null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.(`spec draft failed repo=${job.repo} pr=${job.number}: ${message}`);
      this.deps.store.finishJob(job.jobId, this.now(), message.slice(0, 500));
    }
    return true;
  }

  async list(_context: MethodContext, payload: HubPayload<"spec.list">): Promise<{ items: SpecListItem[] }> {
    const drafts = this.deps.store.listDrafts(payload.project);
    const refreshed = await this.refreshStatuses(drafts);
    return {
      items: refreshed.map((draft) => ({ id: draft.id, title: draft.title, status: draft.status, prUrl: draft.prUrl, updatedAt: draft.updatedAt })),
    };
  }

  async get(_context: MethodContext, payload: HubPayload<"spec.get">): Promise<SpecListItem & { body: string; project: string; repo: string; prNumber: number; reviewedBy: string | null }> {
    const draft = this.deps.store.getDraft(payload.id);
    if (!draft) throw new HubError("not_found", "spec draft not found");
    const [current] = await this.refreshStatuses([draft]);
    const view = current ?? draft;
    return {
      id: view.id, title: view.title, status: view.status, prUrl: view.prUrl, updatedAt: view.updatedAt,
      body: view.body, project: view.project, repo: view.repo, prNumber: view.prNumber, reviewedBy: view.reviewedBy,
    };
  }

  async review(context: MethodContext, payload: HubPayload<"spec.review">): Promise<{ id: string; status: SpecDraftRecord["status"] }> {
    const draft = this.deps.store.getDraft(payload.id);
    if (!draft) throw new HubError("not_found", "spec draft not found");
    if (draft.status !== "draft") throw new HubError("invalid_request", `spec draft is already ${draft.status}`);
    const pending = await this.deps.praeforma.pendingReconstruction(draft.praeformaProjectId);
    if (!pending || (draft.reconstructionId !== null && pending.id !== draft.reconstructionId)) {
      throw new HubError("upstream_unavailable", "no reconstruction proposal is pending for this draft in Praeforma");
    }
    const actor = context.identity.member;
    await this.deps.praeforma.decide(draft.praeformaProjectId, pending.id, reconstructionDecision({
      decision: payload.decision, changeCount: pending.changeCount, comment: payload.comment ?? null, actorName: actor.displayName,
    }));
    const status = payload.decision === "accept" ? "accepted" : "rejected";
    this.deps.store.updateDraft(draft.id, {
      status, reviewedBy: actor.discordUserId, reviewComment: payload.comment ?? null,
      reconstructionId: pending.id, updatedAt: this.now(),
    });
    this.deps.audit.record({
      kind: "operation", tokenId: context.identity.token.id, discordUserId: actor.discordUserId, country: null, ip: null,
      operation: "spec.review", result: payload.decision, detail: draft.id,
    });
    return { id: draft.id, status };
  }

  private async draft(job: SpecJob): Promise<void> {
    const binding = findSpecRepo(job.repo, this.deps.specRepos);
    if (!binding) throw new Error("repo is no longer in glabUnityHub.specRepos");
    const diff = await this.deps.github.pullRequestDiff(job.repo, job.number);
    const content = buildFragmentContent(job, diff);
    const fragment = await this.deps.praeforma.createFragment(binding.praeformaProjectId, {
      content, sourceEventId: specSourceEventId(job),
    });
    const reconstruction = await this.deps.praeforma.requestReconstruction(binding.praeformaProjectId);
    const now = this.now();
    this.deps.store.saveDraft({
      id: randomUUID(),
      project: binding.project,
      repo: job.repo,
      prNumber: job.number,
      prUrl: job.url,
      headSha: job.headSha,
      title: job.title,
      praeformaProjectId: binding.praeformaProjectId,
      fragmentId: fragment.fragmentId,
      reconstructionId: reconstruction.reconstructionId,
      status: "draft",
      body: content,
      reviewedBy: null,
      reviewComment: null,
      createdAt: now,
      updatedAt: now,
    });
    if (reconstruction.reconstructionId === null) {
      this.deps.log?.(`spec reconstruction not prepared repo=${job.repo} pr=${job.number}: ${reconstruction.reason}`);
    }
    await this.deps.github.commentOnPullRequest(job.repo, job.number, specDraftComment({
      link: this.deps.praeforma.linkFor(binding.praeformaProjectId),
      reconstructionPrepared: reconstruction.reconstructionId !== null,
    }));
  }

  /** Praeforma の断片の処理結果で状態を読み直す。 読めなければ手元の状態のまま返す。 */
  private async refreshStatuses(drafts: readonly SpecDraftRecord[]): Promise<SpecDraftRecord[]> {
    const byProject = new Map<string, Map<string, string> | null>();
    const result: SpecDraftRecord[] = [];
    for (const draft of drafts) {
      if (!byProject.has(draft.praeformaProjectId)) {
        byProject.set(draft.praeformaProjectId, await this.deps.praeforma.fragmentDispositions(draft.praeformaProjectId).catch(() => null));
      }
      const dispositions = byProject.get(draft.praeformaProjectId);
      const state = draft.fragmentId ? dispositions?.get(draft.fragmentId) : undefined;
      if (state === undefined) {
        result.push(draft);
        continue;
      }
      const status = statusFromDisposition(state);
      if (status !== draft.status && status !== "draft") {
        const updatedAt = this.now();
        this.deps.store.updateDraft(draft.id, { status, updatedAt });
        result.push({ ...draft, status, updatedAt });
      } else {
        result.push(draft);
      }
    }
    return result;
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}
