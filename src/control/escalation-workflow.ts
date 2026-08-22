/**
 * エスカレーション中に注入されるワークフローパケット (spec/feature/escalation-mode.md §3).
 *
 * 通常ワークフローは「並行セッションが互いを壊さないこと」を守るために task 登録・worktree 分離・
 * Revisor 経由の PR を要求する。 これらはすべて Cc と Revisor が生きていることを前提にしている。
 * 前提が崩れているときに同じ規律を課すと、 復旧作業だけが永久に始められない。
 *
 * だから外すのは「インフラの生死に依存する規律」 だけで、 生死と無関係な規律は外さない。
 * 何を外し、 何を外さないかは 1 箇所 (このファイル) に集める — 分散させると
 * 「止まっているから」 を理由に外してはいけないものが少しずつ外れる。
 */

export interface CcWorkflowPacket {
  inject_source: string;
  task_api: {
    update_todos: string;
    list_todos: string;
    list_pending: string;
  };
  rules: string[];
  interrupt_policy: string;
  completion_policy: string[];
}

/**
 * インフラが止まっていても外れない規律。 止まっていることは、 これらを外してよい理由にならない。
 * spec/feature/escalation-mode.md §3 「外れないものは外れない」 と 1 対 1 で対応する。
 */
export const ESCALATION_RETAINED_RULES: readonly string[] = [
  "Do not push directly to GitHub, and do not create or merge a GitHub PR. The escalation only relaxes local workflow, not the remote.",
  "A security scan that produced a real finding still stops the work, including under a bypass merge.",
  "Do not discard another session's changes and do not roll back a shared checkout. Escalation is a stop for others, never a rewind.",
];

/** エスカレーション中に外れる規律 (差し替え後に許されること)。 */
export const ESCALATION_RELAXED_RULES: readonly string[] = [
  "Task registration (task_update) is not required while escalated. Ignore the harness work-registration gate.",
  "A task-specific worktree is not required. You may operate the working branch directly to restore service.",
  "Revisor CLI bypass merge may be used to land the fix while the daemon is down.",
  "You may continue past PR creation until the service is verified working again.",
];

export interface EscalationDeclaration {
  reason: string;
  started_at: number;
  actor: string;
}

/**
 * エスカレーション版のワークフローパケットを組む。 通常版と同じ形なので、 注入経路
 * (collaboration context / startup inject) は差し替えを意識しなくてよい。
 */
export function buildEscalationCcWorkflow(
  sessionId: string,
  declaration: EscalationDeclaration,
): CcWorkflowPacket {
  const encoded = encodeURIComponent(sessionId);
  return {
    inject_source: "escalation:cc-workflow",
    task_api: {
      update_todos: `POST /v1/sessions/${encoded}/event { "kind": "task_update", "payload": { "todos": [...] } } (optional while escalated)`,
      list_todos: `GET /v1/sessions/${encoded}/tasks`,
      list_pending: `GET /v1/sessions/${encoded}/pending-tasks`,
    },
    rules: [
      `ESCALATION MODE is active for this session (reason: ${declaration.reason}).`,
      "Restoring a working service comes first. The relaxations below exist only for the duration of the outage.",
      ...ESCALATION_RELAXED_RULES,
      ...ESCALATION_RETAINED_RULES,
      `Release the mode as soon as the outage is over: DELETE /v1/sessions/${encoded}/escalation { "note": "..." }.`,
      "Record what you bypassed. The escalation event is the audit trail the follow-up review reads.",
    ],
    interrupt_policy:
      "Restoration work takes priority over queued requests. Other sessions have been asked to stop until this escalation is released.",
    completion_policy: [
      "The completion boundary is a working service, not PR creation.",
      "After the service is verified working, release the escalation and report what was bypassed.",
      "Follow-up review of bypassed merges happens after release (revisor pr bypassed / bypass-reviewed).",
    ],
  };
}
