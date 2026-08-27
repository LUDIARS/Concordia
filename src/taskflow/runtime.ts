import type Database from "better-sqlite3";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRepo, DelegationRunRow } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { TaskMdStore } from "./md-store.js";
import type { RevisorLocalPrReader } from "../pr/revisor-client.js";
import { CompletionBlackbox } from "./completion-blackbox.js";
import { findSessionLocalPr, findSessionPr, runGoalMachine } from "./goal-machine.js";
import { checkResidual } from "./residual-blackbox.js";
import { eventBus } from "../events.js";
import { finishAutonomousTaskflow } from "./session-end.js";
import type { PendingQuestionProbe } from "../control/pending-question-blocker.js";
import { startTeardownLadderWatch } from "./teardown-ladder.js";
import type { SessionRow } from "../shared/types.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { startAskDetachWatch } from "./ask-detach.js";

export interface TaskflowRuntimeDeps {
  db: Database.Database;
  sessions: SessionsRepo;
  delegation: DelegationRepo;
  prs: PrRecordsRepo;
  store: TaskMdStore;
  confirm: ConfirmIntakeDeps;
  /** Revisor local PR の読み取り口。 未注入なら GitHub PR のみで判断する (従来互換)。 */
  revisor?: RevisorLocalPrReader;
  mentionUserId: () => string | null;
  /** 未回答の質問があるセッションには自動 inject を送らない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
  endSession?: (session: SessionRow, reason: string) => Promise<unknown>;
  pendingQuestions?: DiscordPendingQuestionsRepo;
  delegationService?: DelegationService;
}

export class TaskflowRuntime {
  private readonly completion: CompletionBlackbox;
  constructor(private readonly deps: TaskflowRuntimeDeps) { this.completion = new CompletionBlackbox(deps.db); }

  async handleCompletedRun(run: DelegationRunRow): Promise<void> {
    const sessionId = run.child_session_id ?? run.parent_session_id;
    if (!sessionId) return;
    const goalOutcome = await runGoalMachine({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs, confirm: this.deps.confirm, revisor: this.deps.revisor, mentionUserId: this.deps.mentionUserId() });
    const residualOutcome = await checkResidual({ sessionId, sessions: this.deps.sessions, store: this.deps.store, mentionUserId: this.deps.mentionUserId(), hasPendingQuestion: this.deps.hasPendingQuestion });
    if (!run.child_session_id) return;
    finishAutonomousTaskflow({
      sessionId,
      sessions: this.deps.sessions,
      taskflowRun: run,
      goalOutcome,
      residualOutcome,
      hasPendingQuestion: this.deps.hasPendingQuestion,
    });
  }

  start(): { stop(): void } {
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.event" && ["final_answer", "summary"].includes(event.kind)) {
        void this.handleInteractiveCompletion(event.session_id);
        return;
      }
      // Revisor の審査終局通知 (session.inject, source="revisor")。 auto-merge は
      // セッションの final_answer より後に来うるため、 ここでもゴール判断を発火しないと
      // 「local PR がマージされたのに confirm キューに入らない」接続断が残る。
      // runGoalMachine 側の intake は冪等なので二重発火しても confirm は増えない。
      if (event.type === "session.inject" && event.source === "revisor") {
        void this.handleRevisorNotice(event.target_session_id);
      }
    });
    const ladder = this.deps.endSession ? startTeardownLadderWatch({ sessions: this.deps.sessions, endSession: this.deps.endSession }) : null;
    const askDetach = this.deps.pendingQuestions && this.deps.delegationService
      ? startAskDetachWatch({ sessions: this.deps.sessions, runs: this.deps.delegation, questions: this.deps.pendingQuestions, service: this.deps.delegationService }) : null;
    return { stop: () => { unsubscribe(); ladder?.stop(); askDetach?.stop(); } };
  }

  private async handleRevisorNotice(sessionId: string): Promise<void> {
    const taskflowRun = this.deps.delegation.findRunByChildSession(sessionId);
    // 先に「マージ済みか」だけを確かめる。 failed / action_required の通知でゴール判断を
    // 走らせると、 判断途中の notify (pr-decision メンション等) が修正待ちのセッションに
    // 二重で刺さる。 マージ済みの時だけ本経路 (confirm キュー + 残作業) へ合流する。
    const pr = findSessionPr({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs });
    const localPr = this.deps.revisor
      ? await findSessionLocalPr({ sessionId, sessions: this.deps.sessions, revisor: this.deps.revisor })
      : null;
    if (pr?.state !== "merged" && localPr?.status !== "merged") return;
    const goalOutcome = await runGoalMachine({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs, confirm: this.deps.confirm, revisor: this.deps.revisor, mentionUserId: this.deps.mentionUserId() });
    const residualOutcome = await checkResidual({ sessionId, sessions: this.deps.sessions, store: this.deps.store, mentionUserId: this.deps.mentionUserId(), hasPendingQuestion: this.deps.hasPendingQuestion });
    if (!taskflowRun) return;
    finishAutonomousTaskflow({ sessionId, sessions: this.deps.sessions, taskflowRun, goalOutcome, residualOutcome, hasPendingQuestion: this.deps.hasPendingQuestion });
  }

  private async handleInteractiveCompletion(sessionId: string): Promise<void> {
    if (this.deps.delegation.findRunByChildSession(sessionId)) return;
    const events = this.deps.sessions.recentEvents(sessionId, 100);
    const latest = events.find((event) => event.kind === "final_answer" || event.kind === "summary");
    let payload: Record<string, unknown> = {};
    try { payload = latest ? JSON.parse(latest.payload) as Record<string, unknown> : {}; } catch { /* empty */ }
    const finalText = [payload.text, payload.summary].find((value): value is string => typeof value === "string") ?? "";
    const commandText = events.map((event) => event.payload).join("\n");
    const pr = findSessionPr({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs });
    // Revisor 運用は push しないため、 GitHub PR も push 痕跡も無い実装完了が普通に
    // 起きる。 local PR の状態を completion 黒箱の prState として補完しないと、
    // seed rule (push/diff 無し → not-implementation) に誤って落ちる。
    const localPr = !pr && this.deps.revisor
      ? await findSessionLocalPr({ sessionId, sessions: this.deps.sessions, revisor: this.deps.revisor })
      : null;
    const localPrState = localPr?.status === "merged" ? "merged" : localPr ? "open" : null;
    const report = this.deps.sessions.findReport(sessionId);
    let bullets = 0;
    try { bullets = report ? JSON.parse(report.bullets).length : 0; } catch { bullets = report?.bullets.split("\n").filter(Boolean).length ?? 0; }
    const decision = await this.completion.decide({
      sessionId,
      prState: pr?.state ?? localPrState ?? "none",
      hasPushOrCommit: /\bgit\s+(?:push|commit)\b/i.test(commandText),
      hasDiff: /\bgit\s+diff\b/i.test(commandText),
      finalText,
      reportBullets: bullets,
    });
    if (decision.verdict !== "completed") return;
    eventBus.emit({ type: "taskflow.completion_detected", session_id: sessionId, pr_number: pr?.number ?? null, outcome: pr?.state ?? "unknown", decision_id: decision.decisionId, ts: Math.floor(Date.now() / 1000) });
    await runGoalMachine({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs, confirm: this.deps.confirm, mentionUserId: this.deps.mentionUserId() });
    await checkResidual({ sessionId, sessions: this.deps.sessions, store: this.deps.store, mentionUserId: this.deps.mentionUserId(), hasPendingQuestion: this.deps.hasPendingQuestion });
  }
}
