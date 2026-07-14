import type Database from "better-sqlite3";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRepo, DelegationRunRow } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { TaskMdStore } from "./md-store.js";
import { CompletionBlackbox } from "./completion-blackbox.js";
import { findSessionPr, runGoalMachine } from "./goal-machine.js";
import { checkResidual } from "./residual-blackbox.js";
import { eventBus } from "../events.js";

export interface TaskflowRuntimeDeps {
  db: Database.Database;
  sessions: SessionsRepo;
  delegation: DelegationRepo;
  prs: PrRecordsRepo;
  store: TaskMdStore;
  confirm: ConfirmIntakeDeps;
  mentionUserId: () => string | null;
}

export class TaskflowRuntime {
  private readonly completion: CompletionBlackbox;
  constructor(private readonly deps: TaskflowRuntimeDeps) { this.completion = new CompletionBlackbox(deps.db); }

  async handleCompletedRun(run: DelegationRunRow): Promise<void> {
    const sessionId = run.child_session_id ?? run.parent_session_id;
    if (!sessionId) return;
    await runGoalMachine({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs, confirm: this.deps.confirm, mentionUserId: this.deps.mentionUserId() });
    await checkResidual({ sessionId, sessions: this.deps.sessions, store: this.deps.store, mentionUserId: this.deps.mentionUserId() });
  }

  start(): { stop(): void } {
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type !== "session.event" || !["final_answer", "summary"].includes(event.kind)) return;
      void this.handleInteractiveCompletion(event.session_id);
    });
    return { stop: unsubscribe };
  }

  private async handleInteractiveCompletion(sessionId: string): Promise<void> {
    if (this.deps.delegation.recentRuns(500).some((run) => run.child_session_id === sessionId)) return;
    const events = this.deps.sessions.recentEvents(sessionId, 100);
    const latest = events.find((event) => event.kind === "final_answer" || event.kind === "summary");
    let payload: Record<string, unknown> = {};
    try { payload = latest ? JSON.parse(latest.payload) as Record<string, unknown> : {}; } catch { /* empty */ }
    const finalText = [payload.text, payload.summary].find((value): value is string => typeof value === "string") ?? "";
    const commandText = events.map((event) => event.payload).join("\n");
    const pr = findSessionPr({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs });
    const report = this.deps.sessions.findReport(sessionId);
    let bullets = 0;
    try { bullets = report ? JSON.parse(report.bullets).length : 0; } catch { bullets = report?.bullets.split("\n").filter(Boolean).length ?? 0; }
    const decision = await this.completion.decide({
      sessionId,
      prState: pr?.state ?? "none",
      hasPushOrCommit: /\bgit\s+(?:push|commit)\b/i.test(commandText),
      hasDiff: /\bgit\s+diff\b/i.test(commandText),
      finalText,
      reportBullets: bullets,
    });
    if (decision.verdict !== "completed") return;
    eventBus.emit({ type: "taskflow.completion_detected", session_id: sessionId, pr_number: pr?.number ?? null, outcome: pr?.state ?? "unknown", decision_id: decision.decisionId, ts: Math.floor(Date.now() / 1000) });
    await runGoalMachine({ sessionId, sessions: this.deps.sessions, prs: this.deps.prs, confirm: this.deps.confirm, mentionUserId: this.deps.mentionUserId() });
    await checkResidual({ sessionId, sessions: this.deps.sessions, store: this.deps.store, mentionUserId: this.deps.mentionUserId() });
  }
}
