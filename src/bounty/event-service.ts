/**
 * バグバウンティ企画の use case (spec/feature/bug-bounty.md §0 §8.2 §18)。
 *
 * 権限者 (WebUI の管理面) が企画を作成・編集・早期終了する。 検証は event-policy.ts の純関数、 保存は store の port。
 * 受付 (intake-service.ts) と案内 (workflow-guidance / 起動案内) は `openAt` で開催中の企画を読む。
 *
 * @implements SPEC-BOUNTY-EVENT
 */

import type { BountyEventRecord } from "../db/bounty-events-repo.js";
import {
  bountyEventPhase,
  validateBountyEventDraft,
  type BountyEvent,
  type BountyEventDraft,
  type BountyEventDraftError,
  type BountyEventFields,
  type BountyEventPhase,
} from "./event-policy.js";

export interface BountyEventStore {
  create(fields: BountyEventFields, createdBy: string, now?: number): BountyEventRecord;
  find(id: string): BountyEventRecord | null;
  list(): BountyEventRecord[];
  listOpenAt(now: number): BountyEventRecord[];
  update(id: string, fields: BountyEventFields, expectUpdatedAt: number, now?: number): boolean;
  endEarly(id: string, endedBy: string, now?: number): boolean;
}

export interface BountyEventServiceDeps {
  events: BountyEventStore;
  /** project registry に登録済みのコード。 */
  projectCodes(): readonly string[];
  now?: () => number;
}

export type BountyEventError = BountyEventDraftError | "event_not_found" | "state_changed";

export type BountyEventResult = { ok: true; event: BountyEventView } | { ok: false; error: BountyEventError };

/** 一覧・応答の形 (段階付き)。 */
export interface BountyEventView extends BountyEventRecord {
  phase: BountyEventPhase;
}

export class BountyEventService {
  private readonly now: () => number;

  constructor(private readonly deps: BountyEventServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  list(): BountyEventView[] {
    const now = this.now();
    return this.deps.events.list().map((event) => this.view(event, now));
  }

  find(id: string): BountyEvent | null {
    return this.deps.events.find(id);
  }

  /** その時刻に開催中の企画。 受付の紐付けと案内が読む。 */
  openAt(now: number = this.now()): BountyEvent[] {
    return this.deps.events.listOpenAt(now);
  }

  create(draft: BountyEventDraft, actor: string): BountyEventResult {
    const now = this.now();
    const checked = validateBountyEventDraft({ draft, current: null, registeredCodes: this.deps.projectCodes(), now });
    if (!checked.ok) return checked;
    return { ok: true, event: this.view(this.deps.events.create(checked.value, actor, now), now) };
  }

  /** 編集。 渡した項目だけを変える。 検証した後に別の編集が入っていれば書かない (state_changed)。 */
  update(id: string, draft: BountyEventDraft): BountyEventResult {
    const current = this.deps.events.find(id);
    if (!current) return { ok: false, error: "event_not_found" };
    const now = this.now();
    const checked = validateBountyEventDraft({ draft, current, registeredCodes: this.deps.projectCodes(), now });
    if (!checked.ok) return checked;
    if (!this.deps.events.update(id, checked.value, current.updatedAt, now)) return { ok: false, error: "state_changed" };
    return { ok: true, event: this.view(this.deps.events.find(id)!, now) };
  }

  /** 早期終了。 開始前の企画も終えられる (開催されずに終わる)。 終了した企画は終えられない。 */
  endEarly(id: string, actor: string): BountyEventResult {
    const current = this.deps.events.find(id);
    if (!current) return { ok: false, error: "event_not_found" };
    const now = this.now();
    if (bountyEventPhase(current, now) === "ended") return { ok: false, error: "event_ended" };
    if (!this.deps.events.endEarly(id, actor, now)) return { ok: false, error: "state_changed" };
    return { ok: true, event: this.view(this.deps.events.find(id)!, now) };
  }

  private view(event: BountyEventRecord, now: number): BountyEventView {
    return { ...event, phase: bountyEventPhase(event, now) };
  }
}
