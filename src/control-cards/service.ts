/**
 * 管制カードの読み取りと人間の捌きの use case (Web と Discord が同じものを呼ぶ、CC-V5-INV-07)。
 * 人間が変えられるのも捌きの列だけ。カードを閉じられるのは人間依頼の「済み」だけ (CC-V5-INV-02)。
 *
 * @implements spec/feature/control-cards.md — 人間の捌き
 */
import { randomUUID } from "node:crypto";
import { CARD_SUMMARY_MAX_CHARS, clipText, type CardState, type CardTriagePatch, type ControlCard } from "./card-domain.js";
import type { HumanCommandCards } from "./human-command-cards.js";
import { humanCommandSourceKey } from "./human-command-cards.js";
import type { ControlCardsRepository, ReminderRecord } from "./repository.js";

export type HumanCardUpdate =
  | { kind: "updated"; card: ControlCard }
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "not_owned" };

export class ControlCardsService {
  constructor(
    private readonly repo: ControlCardsRepository,
    private readonly humanCommands: HumanCommandCards,
    private readonly now: () => number,
  ) {}

  list(state: CardState | null, limit = 100): ControlCard[] {
    return this.repo.list(state, Math.max(1, Math.min(limit, 500)));
  }

  /** 破棄したカードの件数 (画面の「破棄済み n 件」)。 */
  discardedCount(): number {
    return this.repo.countDiscarded();
  }

  find(id: string): ControlCard | null {
    return this.repo.find(id);
  }

  bySession(sessionId: string): ControlCard[] {
    return this.repo.listBySession(sessionId);
  }

  byDeskRequest(requestId: string): ControlCard[] {
    const key = `desk:${requestId}`;
    const sources = ["desk-project-selection", "desk-routing-issue"];
    return sources.flatMap((source) => this.repo.findBySource(source, key) ?? []);
  }

  reminders(id: string): ReminderRecord[] {
    return this.repo.reminders(id);
  }

  openKaizenJudgment(input: { key: string; project: string | null; summary: string }): ControlCard {
    const now = this.now();
    return this.repo.transaction(() => this.repo.findBySource("kaizen-proposal", input.key) ?? this.repo.open(randomUUID(), {
      source_kind: "kaizen-proposal", source_key: input.key, project: input.project, session_id: null, link: null,
      summary: clipText(input.summary, CARD_SUMMARY_MAX_CHARS), raised_at: now,
    }, now));
  }

  /** 人間の捌き (5 列だけ)。 */
  triage(id: string, patch: CardTriagePatch, actor: string): HumanCardUpdate {
    const card = this.repo.find(id);
    if (!card) return { kind: "not_found" };
    const updated = card.state === "open" ? this.repo.triage(id, patch, `human:${clipText(actor, 100)}`, this.now()) : null;
    return updated ? { kind: "updated", card: updated } : { kind: "closed" };
  }

  /** カードが解決状態を持つ人間依頼・カイゼンの判断を済みにする (CC-V5-INV-02)。 */
  markDone(id: string, actor: string): HumanCardUpdate {
    const card = this.repo.find(id);
    if (!card) return { kind: "not_found" };
    if (card.state !== "open") return { kind: "closed" };
    if (card.source_kind === "kaizen-proposal") {
      const closed = this.repo.close(id, `human:${clipText(actor, 100)}`, this.now()) ? this.repo.find(id) : null;
      return closed ? { kind: "updated", card: closed } : { kind: "closed" };
    }
    if (card.source_kind !== "human-command") return { kind: "not_owned" };
    const closed = this.humanCommands.markDone(card, actor);
    return closed ? { kind: "updated", card: closed } : { kind: "closed" };
  }

  /** Discord の人間依頼の OK ボタン (実装メモ 9「人間依頼の OK でカードも閉じる」)。 */
  markHumanCommandDone(sessionMessageId: number, index: number, actor: string): ControlCard | null {
    const card = this.repo.findBySource("human-command", humanCommandSourceKey(sessionMessageId, index));
    return card ? this.humanCommands.markDone(card, actor) : null;
  }
}
