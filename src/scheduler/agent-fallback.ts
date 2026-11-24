/**
 * 期限内に受け取られない (acked にならない) cron 由来の指令を Cc が failed で閉じ、 元の委託を 1 回だけ起動する use case。
 * 閉じる遷移は「pending なら」の条件付き UPDATE なので、 並行して回っても起動は 1 回 (CC-PT-AGENT-INV-05)。
 * dots が 5 分間隔の自動ポーリングを始めるまでは、 この戻しが毎日の作業を守る。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 受け取られないときの戻し
 */

import type { InstructionRecord } from "../agent-instructions/instruction-service.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import {
  CRON_DEDUPE_PREFIX,
  FALLBACK_CLOSE_DETAIL,
  FALLBACK_CLOSE_SUMMARY,
  REPORT_ONLY_CLOSE_SUMMARY,
  fallbackCutoff,
  parseCronInstructionParams,
  usesReportOnlyRoute,
  type CronInstructionParams,
} from "./agent-dispatch-policy.js";
import { buildFallbackPost, buildReportOnlyExpiryPost } from "./agent-jobs/result-post.js";
import type { CronJobDefinition } from "./cron-jobs.js";

/** 期限切れの確認の間隔。 期限 (既定 180 分) に対して十分細かい。 */
export const AGENT_FALLBACK_INTERVAL_MS = 5 * 60_000;

export type InvokeOriginalResult = { ok: true; runId: string | null } | { ok: false; error: string };

export interface AgentFallbackDeps {
  instructions: {
    listUnreceivedBefore(prefix: string, cutoff: Date): InstructionRecord[];
    closeUnreceived(id: string, summary: string, detail: Record<string, unknown>): boolean;
  };
  fallbackMinutes: () => number;
  invokeOriginal: (params: CronInstructionParams) => Promise<InvokeOriginalResult>;
  post: (text: string) => Promise<unknown>;
  now?: () => Date;
  log: { info(detail: Record<string, unknown>, message: string): void; warn(detail: Record<string, unknown>, message: string): void };
}

export async function runAgentFallback(deps: AgentFallbackDeps): Promise<{ closed: number; invoked: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = fallbackCutoff(now, deps.fallbackMinutes());
  let closed = 0;
  let invoked = 0;
  for (const record of deps.instructions.listUnreceivedBefore(CRON_DEDUPE_PREFIX, cutoff)) {
    const params = parseCronInstructionParams(record.params);
    if (!params) continue;
    if (usesReportOnlyRoute(params.job)) {
      if (!deps.instructions.closeUnreceived(record.id, REPORT_ONLY_CLOSE_SUMMARY, { closed_by: "concordia" })) continue;
      closed += 1;
      try {
        await deps.post(buildReportOnlyExpiryPost(record, params.job));
      } catch (error) {
        deps.log.warn({ id: record.id, error: error instanceof Error ? error.message : String(error) }, "agent expiry post failed");
      }
      continue;
    }
    // 閉じられた (= この呼び出しが所有権を取った) ときだけ起動する。 先に ack されていれば外部エージェントの仕事のまま。
    if (!deps.instructions.closeUnreceived(record.id, FALLBACK_CLOSE_SUMMARY, { ...FALLBACK_CLOSE_DETAIL })) continue;
    closed += 1;
    let result: InvokeOriginalResult;
    try {
      result = await deps.invokeOriginal(params);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) invoked += 1;
    deps.log[result.ok ? "info" : "warn"](
      { id: record.id, job: params.job, target: params.target || null, ...(result.ok ? { runId: result.runId } : { error: result.error }) },
      result.ok ? "agent instruction expired; delegation invoked" : "agent instruction expired; delegation invoke failed",
    );
    try {
      await deps.post(buildFallbackPost({
        title: record.title, agent: record.agent, instructionId: record.id, invoked: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      }));
    } catch (error) {
      // 投稿は後追いの知らせ。 失敗しても戻し (閉じる・起動) は済んでいるので warn だけにする。
      deps.log.warn({ id: record.id, error: error instanceof Error ? error.message : String(error) }, "agent fallback post failed");
    }
  }
  return { closed, invoked };
}

export function startAgentFallbackLoop(deps: AgentFallbackDeps, intervalMs: number = AGENT_FALLBACK_INTERVAL_MS): SupervisedIntervalHandle {
  return startSupervisedInterval("cron-agent-fallback", async () => { await runAgentFallback(deps); }, {
    intervalMs, initialDelayMs: 60_000, log: { warn: (message) => deps.log.warn({}, message) },
  });
}

export interface OriginalInvokerDeps {
  jobs: readonly CronJobDefinition[];
  delegation: {
    invoke(input: { call_name: string; args: Record<string, unknown>; cwd?: string; triggered_by: string; options?: Record<string, unknown> }):
      Promise<{ ok: true; run: { id: string } } | { ok: false; error: unknown }>;
  };
  resolveCallNameOverride?: (jobName: string) => string | null;
}

/** 指令の params から元の委託を起動する口。 call_name は発火時に解決したものを優先する。 */
export function createOriginalInvoker(deps: OriginalInvokerDeps): (params: CronInstructionParams) => Promise<InvokeOriginalResult> {
  return async (params) => {
    const job = deps.jobs.find((candidate) => candidate.name === params.job);
    if (!job) return { ok: false, error: `unknown cron job: ${params.job}` };
    const callName = params.callName ?? deps.resolveCallNameOverride?.(job.name) ?? job.call_name;
    const result = await deps.delegation.invoke({
      call_name: callName,
      args: params.args,
      ...(job.cwd ? { cwd: job.cwd } : {}),
      triggered_by: `cron:${job.name}${params.target ? `:${params.target}` : ""}:agent-fallback`,
      ...(params.options ? { options: params.options } : {}),
    });
    if (!result.ok) return { ok: false, error: typeof result.error === "string" ? result.error : JSON.stringify(result.error) };
    return { ok: true, runId: result.run.id };
  };
}
