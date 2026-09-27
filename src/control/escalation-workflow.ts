import { resolveMajorInjectText, type MajorInjectResolver } from "./major-inject-resolver.js";
export { ESCALATION_RETAINED_RULES, ESCALATION_RELAXED_RULES } from "./workflow-inject-defaults.js";

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

/** エスカレーション中に外れる規律 (差し替え後に許されること)。 */

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
  majorInject?: MajorInjectResolver,
): CcWorkflowPacket {
  const encoded = encodeURIComponent(sessionId);
  return {
    inject_source: "escalation:cc-workflow",
    task_api: {
      update_todos: `POST /v1/sessions/${encoded}/event { "kind": "task_update", "payload": { "todos": [...] } } (optional while escalated)`,
      list_todos: `GET /v1/sessions/${encoded}/tasks`,
      list_pending: `GET /v1/sessions/${encoded}/pending-tasks`,
    },
    rules: resolveMajorInjectText("session.workflow.escalation", majorInject, {
      reason: declaration.reason,
      release_endpoint: `DELETE /v1/sessions/${encoded}/escalation`,
    }).split("\n"),
    interrupt_policy: resolveMajorInjectText("session.workflow.escalation.interrupt", majorInject),
    completion_policy: resolveMajorInjectText("session.workflow.escalation.completion", majorInject).split("\n"),
  };
}
