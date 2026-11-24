/**
 * cron 由来の指令の finished を受け、 ジョブの result applier の文面で従来の出力先へ投稿する use case。
 * 反映するのは Cc だけで、 外部エージェントは result を返すだけ (CC-PT-AGENT-INV-04)。
 * Cc が期限切れで閉じた finished は反映しない (戻しの投稿は agent-fallback.ts が出す)。
 * 閉じた後の ack / result は指令ブリッジが 409 で断り finished を出さないので、 ここへは届かない (CC-PT-AGENT-INV-05)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 結果の引き取り
 */

import type { InstructionEvent } from "../agent-instructions/instruction-events.js";
import { isClosedByConcordia, parseCronInstructionParams } from "./agent-dispatch-policy.js";
import { buildAgentJobResultPost } from "./agent-jobs/result-post.js";
import type { AgentJobRegistry } from "./agent-jobs/registry.js";

export interface AgentResultIntakeDeps {
  /** 指令の params (job を引く)。 */
  paramsOf: (id: string) => unknown;
  jobs: AgentJobRegistry;
  /** 従来の出力先への投稿 (送信側で allowedMentions を空にする)。 */
  post: (text: string) => Promise<unknown>;
  trackedKaizen?: (id: string) => boolean;
}

function parseDetail(detail: string | null): unknown {
  if (detail === null) return null;
  try { return JSON.parse(detail); } catch { return null; }
}

export function createAgentResultIntake(deps: AgentResultIntakeDeps): (event: InstructionEvent) => Promise<void> {
  return async (event) => {
    if (event.kind !== "finished") return;
    if (event.status === "done" && deps.trackedKaizen?.(event.id)) return;
    const params = parseCronInstructionParams(deps.paramsOf(event.id));
    if (!params) return;
    const detail = parseDetail(event.detail);
    if (isClosedByConcordia(detail)) return;
    const kind = deps.jobs.get(params.job)?.resultKind ?? "報告";
    await deps.post(buildAgentJobResultPost(kind, {
      jobName: params.job, title: event.title, agent: event.agent, status: event.status,
      summary: event.summary, detail, instructionId: event.id,
    }));
  };
}
