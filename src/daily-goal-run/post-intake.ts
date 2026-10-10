/**
 * 投稿登録の use case: デイリーゴールチャンネルの投稿を読み、 登録・下書き・目標なしにする。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 目標を投稿する / 2. 読み取りと聞き返し / CC-DG-INV-01 / CC-DG-INV-02 / CC-DG-INV-04 / CC-DG-INV-09
 *
 * 投稿 1 件に下書き 1 行を作り、 読み直すたびに全文 (元投稿 + 元投稿者のスレッド返信) を読む。
 * 構造化した書式は LLM を通さず読む。 読み取った項目は本文の引用で検査し、 そろえば登録する。
 * 読み取りに失敗したら推測で登録せず、 下書きにして書式を案内する。
 */

import { createHash } from "node:crypto";
import { businessDateOf, describeDeadline } from "./business-day.js";
import { authorizeConfirmer, capPermissions } from "./confirmation-policy.js";
import { isNearDeadline, isPastDeadline } from "./deadline-policy.js";
import { evaluateDraft, type CompleteGoalDraft } from "./draft-policy.js";
import { guardExtraction } from "./extraction-guard.js";
import { isNoGoalPost } from "./no-goal-policy.js";
import { draftReply, noGoalReply, registeredReply } from "./post-replies.js";
import { isStructuredPost, parseStructuredPost } from "./structured-post-parser.js";
import type { DailyGoal, DailyGoalDraft, ExtractedGoal, GoalActor } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

/**
 * 操作面への指示。 reply は元投稿への返信 (message)、 thread は元投稿のスレッドへの返信。
 * thread で threadId が null なら操作面がスレッドを作り attachThread で知らせる。
 */
export type IntakeResult =
  | { kind: "ignored" }
  | { kind: "reply"; reply: string }
  | { kind: "thread"; draftId: string; threadId: string | null; reply: string; goalId?: string };

export interface RegisterGoalInput {
  goal: CompleteGoalDraft;
  actor: GoalActor;
  sourceMessageId: string;
  businessDate: string;
  now: number;
}

const NO_PERMISSIONS = { merge: false, test: false, service: false, deploy: false };

export class DailyGoalPostIntake {
  /** 同じ投稿の読み直しを直列にする (編集と返信が重なっても 2 件目を作らない)。 */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly register: (input: RegisterGoalInput) => { goal: DailyGoal; created: boolean },
    private readonly launchSoon: (now: number) => void,
  ) {}

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(key, next);
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); }).catch(() => undefined);
    return next;
  }

  /** チャンネル直下の人間の投稿。 */
  intakePost(input: { text: string; messageId: string; actor: GoalActor; now: number }): Promise<IntakeResult> {
    return this.serial(input.messageId, async () => {
      if (input.actor.isBot || input.actor.isWebhook || !input.text.trim()) return { kind: "ignored" };
      if (this.deps.drafts.bySourceMessage(input.messageId)) return { kind: "ignored" }; // 再配送
      const authorization = authorizeConfirmer(input.actor, NO_PERMISSIONS);
      if (!authorization.ok) return { kind: "reply", reply: authorization.reason };
      const { dayBoundary } = this.deps.config();
      const businessDate = businessDateOf(input.now, dayBoundary);
      if (isNoGoalPost(input.text)) {
        const recorded = this.deps.days.recordNoGoal(businessDate, input.actor.userId, input.now);
        return { kind: "reply", reply: recorded ? noGoalReply(businessDate) : `${businessDate} は既に「目標なし」として記録済みです。` };
      }
      this.deps.days.ensure(businessDate, input.now);
      const id = createHash("sha256").update(`draft:${input.actor.guildId}:${input.messageId}`).digest("hex").slice(0, 24);
      const { draft } = this.deps.drafts.create({
        id, businessDate, sourceMessageId: input.messageId, authorUserId: input.actor.userId,
        guildId: input.actor.guildId, channelId: input.actor.channelId, textParts: [input.text], now: input.now,
      });
      return this.read(draft, draft.textParts, input.actor, input.now);
    });
  }

  /** 聞き返しスレッドでの返信。 元投稿者の返信だけを補足として読む。 */
  supplementDraft(input: { threadId: string; text: string; actor: GoalActor; now: number }): Promise<IntakeResult> {
    const draft = this.deps.drafts.byThread(input.threadId);
    if (!draft) return Promise.resolve({ kind: "ignored" });
    return this.serial(draft.sourceMessageId, async () => {
      const current = this.deps.drafts.byId(draft.id);
      if (!current || current.status !== "open" || current.authorUserId !== input.actor.userId || !input.text.trim()) return { kind: "ignored" };
      return this.read(current, [...current.textParts, input.text], input.actor, input.now);
    });
  }

  /** 元投稿の編集。 open の下書きだけを読み直す (登録済みのゴールは書き換えない)。 */
  postEdited(input: { messageId: string; text: string; actor: GoalActor; now: number }): Promise<IntakeResult> {
    return this.serial(input.messageId, async () => {
      const current = this.deps.drafts.bySourceMessage(input.messageId);
      if (!current || current.status !== "open" || current.authorUserId !== input.actor.userId) return { kind: "ignored" };
      if (current.textParts[0] === input.text) return { kind: "ignored" };
      return this.read(current, [input.text, ...current.textParts.slice(1)], input.actor, input.now);
    });
  }

  attachThread(draftId: string, threadId: string, now: number): void {
    this.deps.drafts.setThread(draftId, threadId, now);
  }

  /** 構造化した書式なら LLM を通さず読む。 書式で埋まらない項目があり自由文が混じるときは全文を LLM で読む。 */
  private async extract(parts: readonly string[], text: string): Promise<{ ok: true; raw: ExtractedGoal } | { ok: false; error: string }> {
    if (isStructuredPost(text)) {
      const structured = parseStructuredPost(text);
      const complete = !!structured.project && !!structured.goalText && structured.acceptance.length > 0;
      if (complete || parts.every((part) => isStructuredPost(part))) return { ok: true, raw: structured };
    }
    const result = await this.deps.extraction.extract(text);
    return result.ok ? { ok: true, raw: result.extracted } : result;
  }

  private async read(draft: DailyGoalDraft, parts: string[], actor: GoalActor, now: number): Promise<IntakeResult> {
    const thread = (reply: string, goalId?: string): IntakeResult => ({
      kind: "thread", draftId: draft.id, threadId: draft.threadId ?? null, reply, ...(goalId ? { goalId } : {}),
    });
    const { dayBoundary } = this.deps.config();
    if (isPastDeadline(draft.businessDate, now, dayBoundary)) {
      this.deps.drafts.expireOn(draft.businessDate, now);
      return thread(`${draft.businessDate} の締切を過ぎたため、この下書きは登録しません。新しく投稿してください。`);
    }
    const text = parts.join("\n\n");
    const extraction = await this.extract(parts, text);
    if (!extraction.ok) {
      this.deps.drafts.saveReading(draft.id, { textParts: parts, extracted: null, missing: ["project", "goal", "acceptance"], now });
      return thread(draftReply({ extracted: null, project: null, missing: ["project", "goal", "acceptance"], failure: extraction.error }));
    }
    const { extracted } = guardExtraction(text, extraction.raw);
    const resolved = extracted.project ? this.deps.projects.resolve(extracted.project) : null;
    const decision = evaluateDraft(extracted, resolved);
    if (decision.status === "missing") {
      this.deps.drafts.saveReading(draft.id, { textParts: parts, extracted, missing: decision.missing, now });
      return thread(draftReply({ extracted, project: resolved?.project ?? null, missing: decision.missing }));
    }
    const capped = capPermissions(actor, decision.goal.permissions);
    const authorization = authorizeConfirmer(actor, capped.permissions);
    if (!authorization.ok) {
      this.deps.drafts.saveReading(draft.id, { textParts: parts, extracted, missing: [], now });
      return thread(authorization.reason);
    }
    this.deps.drafts.saveReading(draft.id, { textParts: parts, extracted, missing: [], now });
    const { goal } = this.register({
      goal: { ...decision.goal, permissions: capped.permissions }, actor, sourceMessageId: draft.sourceMessageId,
      businessDate: draft.businessDate, now,
    });
    this.deps.drafts.markRegistered(draft.id, goal.id, now);
    this.launchSoon(now);
    return thread(registeredReply(goal, {
      droppedPermissions: capped.dropped,
      deadline: describeDeadline(goal.date, dayBoundary),
      nearDeadline: isNearDeadline(goal.date, now, dayBoundary),
    }), goal.id);
  }
}
