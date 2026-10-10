/**
 * デイリーゴール自走の application service (use case の窓口)。
 *
 * @implements spec/feature/daily-goal-run.md — 流れ 1〜6 / CC-DG-INV-01〜08
 *
 * 確定 (confirmGoal) はここ、 起動・確認・終了・候補は専用モジュールへ委ねる。
 * 認可と副作用の順序を明示し、 外部 I/O は port 経由で行う。
 */

import { createHash } from "node:crypto";
import { authorizeConfirmer, validateDraft } from "./confirmation-policy.js";
import { localDate, nextDate } from "./launch-policy.js";
import { DailyGoalLauncher } from "./launch.js";
import { DailyGoalCheckpointer } from "./checkpoint.js";
import { DailyGoalFinisher, type EvidenceClaim, type ExhaustedOutcome, type ReachedOutcome } from "./finish.js";
import { DailyGoalCandidates } from "./candidates.js";
import { buildCandidateCard, buildGoalCard, type DailyGoalCardView } from "./card.js";
import { DailyGoalConflict } from "./domain.js";
import type { DailyGoal, DailyGoalCheckpoint, DraftField, GoalActor, GoalCandidate, GoalDraft, RemainingItem } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";
import type { DailyGoalCard, TimelineEntry } from "./repository.js";

export type ConfirmResult =
  | { ok: true; goal: DailyGoal; created: boolean }
  | { ok: false; kind: "missing"; missing: DraftField[] }
  | { ok: false; kind: "forbidden" | "unknown_project"; reason: string };

export interface DailyGoalDetail {
  goal: DailyGoal;
  checkpoints: DailyGoalCheckpoint[];
  timeline: TimelineEntry[];
  card: DailyGoalCard | null;
}

export function goalCardId(goalId: string): string { return `goal-${goalId}`; }

export class DailyGoalRunService {
  private readonly launcher: DailyGoalLauncher;
  private readonly checkpointer: DailyGoalCheckpointer;
  private readonly finisher: DailyGoalFinisher;
  private readonly candidates: DailyGoalCandidates;

  constructor(readonly deps: DailyGoalServiceDeps) {
    const touch = (goalId: string, line?: string): void => this.touch(goalId, line);
    this.launcher = new DailyGoalLauncher(deps, touch);
    this.finisher = new DailyGoalFinisher(deps, touch, (goal, now) => this.queueNextDayCandidate(goal, now));
    this.checkpointer = new DailyGoalCheckpointer(deps, touch, (sessionId, now) => this.finisher.onSessionLost(sessionId, now));
    this.candidates = new DailyGoalCandidates(deps, (candidateId) => deps.repo.touchCard(candidateId, "candidate", candidateId));
  }

  /** カードの版を上げ、 必要ならタイムラインに 1 行足す。 */
  private touch(goalId: string, line?: string): void {
    if (line) this.deps.repo.addTimeline(goalId, Date.now(), line);
    this.deps.repo.touchCard(goalCardId(goalId), "goal", goalId);
  }

  /**
   * 人間本人の確定。 欠けがあれば確定せず欠けた項目を返す。 receiptId は確定操作の受付 ID
   * (Discord interaction id 等) で、 同じ操作の再送は同じゴールを返す。
   */
  confirmGoal(input: { draft: GoalDraft; actor: GoalActor; receiptId: string; now: number }): ConfirmResult {
    const project = input.draft.project?.trim() ? this.deps.projects.resolve(input.draft.project.trim()) : null;
    if (input.draft.project?.trim() && !project) {
      return { ok: false, kind: "unknown_project", reason: `プロジェクト「${input.draft.project.trim()}」は登録されていません。` };
    }
    const validation = validateDraft({ ...input.draft, project: project?.project ?? null, repoPath: project?.repoPath ?? null });
    if (!validation.ok) return { ok: false, kind: "missing", missing: validation.missing };
    const authorization = authorizeConfirmer(input.actor, validation.draft.permissions);
    if (!authorization.ok) return { ok: false, kind: "forbidden", reason: authorization.reason };
    const id = createHash("sha256").update(`${input.actor.platform}:${input.actor.guildId}:${input.receiptId}`).digest("hex").slice(0, 24);
    const { goal, created } = this.deps.repo.create({
      id, date: localDate(input.now), ...validation.draft,
      confirmedBy: {
        platform: "discord", userId: input.actor.userId, guildId: input.actor.guildId, channelId: input.actor.channelId,
        ...(input.actor.messageId ? { messageId: input.actor.messageId } : {}),
      },
      confirmedAt: input.now, createdAt: input.now,
    });
    if (created) this.touch(goal.id, `<@${input.actor.userId}> がゴールを確定しました`);
    return { ok: true, goal, created };
  }

  /** scheduler の 1 tick。 起動・照合・確認・候補の順に進める。 */
  async tick(now: number): Promise<void> {
    this.launcher.reconcile(now);
    await this.launcher.launchDue(now);
    this.launcher.reconcile(now);
    await this.checkpointer.runDue(now);
    await this.candidates.prepareIfDue(now);
  }

  launchDue(now: number): Promise<void> { return this.launcher.launchDue(now); }
  runCheckpoint(goalId: string, now: number) { return this.checkpointer.run(goalId, now); }
  reportReached(goalId: string, sessionId: string, claims: readonly EvidenceClaim[], now: number): Promise<ReachedOutcome> {
    return this.finisher.reportReached(goalId, sessionId, claims, now);
  }
  reportExhausted(goalId: string, sessionId: string, remaining: readonly RemainingItem[], now: number): ExhaustedOutcome {
    return this.finisher.reportExhausted(goalId, sessionId, remaining, now);
  }
  stopByHuman(goalId: string, actor: GoalActor, now: number): DailyGoal { return this.finisher.stopByHuman(goalId, actor, now); }
  onSessionLost(sessionId: string, now: number): void { this.finisher.onSessionLost(sessionId, now); }
  prepareCandidates(date: string, now: number): Promise<void> { return this.candidates.prepare(date, now); }

  list(date?: string): DailyGoal[] { return this.deps.repo.list(date ? { date } : {}); }
  detail(goalId: string): DailyGoalDetail | null {
    const goal = this.deps.repo.byId(goalId);
    if (!goal) return null;
    return { goal, checkpoints: this.deps.repo.checkpoints(goalId), timeline: this.deps.repo.timeline(goalId), card: this.deps.repo.card(goalCardId(goalId)) };
  }
  candidate(candidateId: string): GoalCandidate | null { return this.deps.repo.candidate(candidateId); }

  /**
   * セッションの報告 (進み具合・次の 1 時間・判断点) を直近の確認へ記録する。
   * 自己申告であり、 進捗・到達の判定には使わない (CC-DG-INV-03)。
   */
  recordReport(goalId: string, sessionId: string, text: string): void {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new DailyGoalConflict("このゴールに紐付いた専用セッションではありません。", "forbidden");
    const last = this.deps.repo.lastCheckpoint(goalId, ["progress", "completion"]);
    if (!last) throw new DailyGoalConflict("報告できる確認がまだありません。", "no_checkpoint");
    this.deps.repo.setCheckpointReport(last.id, text.trim().slice(0, 2000));
    this.touch(goalId);
  }

  /** 配達側が描画するカードの中身。 */
  cardContent(card: DailyGoalCard, now: number):
    | { kind: "goal"; goalId: string; view: DailyGoalCardView }
    | { kind: "candidate"; candidate: GoalCandidate; view: ReturnType<typeof buildCandidateCard> }
    | null {
    if (card.kind === "candidate") {
      const candidate = this.deps.repo.candidate(card.refId);
      return candidate ? { kind: "candidate", candidate, view: buildCandidateCard(candidate) } : null;
    }
    const goal = this.deps.repo.byId(card.refId);
    if (!goal) return null;
    const waiting = goal.status === "running" && !!goal.sessionId && this.deps.waiting.isWaiting(goal.sessionId);
    return { kind: "goal", goalId: goal.id, view: buildGoalCard({ goal, checkpoints: this.deps.repo.checkpoints(goal.id), timeline: this.deps.repo.timeline(goal.id), waiting, now }) };
  }

  /** やり切りの残りは翌朝の「候補」に入れる。 ゴールには自動でならない (CC-DG-INV-08)。 */
  private queueNextDayCandidate(goal: DailyGoal, now: number): void {
    if (!this.deps.config().candidateProjects.length) return;
    void this.candidates.prepare(nextDate(goal.date), now, goal.project)
      .catch((error) => this.deps.log?.warn(`daily goal next-day candidate failed goal=${goal.id}: ${String(error)}`));
  }
}
