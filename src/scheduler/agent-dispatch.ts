/**
 * 定時ジョブの発火 (fanout なら対象ごと) を、 宛先が外部エージェントなら指令 1 件の登録へ回す use case。
 * 宛先未設定 (既定) なら not_routed を返し、 cron scheduler が従来どおり委託を invoke する (CC-PT-AGENT-INV-01)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 発火の分岐
 */

import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import type { RegisterInput } from "../agent-instructions/instruction-service.js";
import { buildDedupeKey, fitParams, scrubValue, usesReportOnlyRoute } from "./agent-dispatch-policy.js";
import type { AgentJobRegistry } from "./agent-jobs/registry.js";

const TITLE_CHARS = 200;

export interface AgentDispatchInput {
  jobName: string;
  /** fanout の対象キー。 fanout 無しは ""。 */
  targetKey: string;
  args: Record<string, unknown>;
  options?: Record<string, unknown> | undefined;
  /** 発火時に解決した委託の call_name (戻しのときに同じものを起動する)。 */
  callName: string;
  firedAt: Date;
}

export type AgentDispatchOutcome =
  | { kind: "not_routed" }
  | { kind: "deferred" | "hq_only"; agent: InstructionAgent }
  | { kind: "registered" | "duplicate"; id: string; agent: InstructionAgent };

export interface AgentDispatchDeps {
  /** ジョブの宛先。 null = 従来の委託。 発火ごとに読む (切替に再起動は要らない)。 */
  resolveAgent: (jobName: string) => InstructionAgent | null;
  jobs: AgentJobRegistry;
  isSiteRole?: () => boolean;
  instructions: { registerOnce(input: RegisterInput & { dedupeKey: string }): { kind: "registered" | "duplicate"; id: string } };
  /** 委託テンプレートの title (指令の題にする)。 */
  templateTitle: (callName: string) => string | null;
  log: { warn(detail: Record<string, unknown>, message: string): void };
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function titleOf(deps: AgentDispatchDeps, input: AgentDispatchInput): string {
  const base = deps.templateTitle(input.callName) ?? input.jobName;
  const team = typeof input.args.team_name === "string" && input.args.team_name.trim() !== "" ? input.args.team_name.trim() : "";
  return clip(team ? `${base} — ${team}` : base, TITLE_CHARS);
}

export function createAgentDispatcher(deps: AgentDispatchDeps): (input: AgentDispatchInput) => Promise<AgentDispatchOutcome> {
  return async (input) => {
    const agent = deps.resolveAgent(input.jobName);
    if (!agent) return { kind: "not_routed" };
    const reportOnly = usesReportOnlyRoute(input.jobName);
    if (reportOnly && deps.isSiteRole?.()) return { kind: "hq_only", agent };
    const spec = deps.jobs.get(input.jobName);
    if (!spec) {
      // 設定の保存時に 400 で断っている (CC-PT-AGENT-INV-06)。 DB を直接書かれた等で届いたら委託へ回す (作業を落とさない)。
      deps.log.warn({ job: input.jobName, agent }, "cron job routed to an agent without an agent job definition; using delegation");
      return { kind: "not_routed" };
    }
    const dedupeKey = buildDedupeKey(input.jobName, input.targetKey, input.firedAt);
    const prepared = spec.prepare ? await spec.prepare(dedupeKey) : undefined;
    if (prepared === null) return { kind: "deferred", agent };
    const data = scrubValue(await spec.buildData({ firedAt: input.firedAt, targetKey: input.targetKey, args: input.args }, prepared));
    const envelope = scrubValue({
      job: input.jobName,
      ...(input.targetKey ? { target: input.targetKey } : {}),
      fired_at: input.firedAt.toISOString(),
      dedupe_key: dedupeKey,
      ...(reportOnly ? {} : {
        call_name: input.callName,
        args: input.args,
        ...(input.options ? { options: input.options } : {}),
      }),
    });
    const params = fitParams(envelope, data);
    const outcome = deps.instructions.registerOnce({
      agent, type: "run_task", title: titleOf(deps, input), body: spec.body, params, dedupeKey,
    });
    return { ...outcome, agent };
  };
}
