/**
 * LUDIARS ダッシュボード日報 (`ludiars-status-daily`) の外部エージェント版。
 * サービスの稼働状態を渡して要約だけを返してもらう。 日報ファイルの更新と PR は Cc の委託側の仕事 (今回は移さない)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 日報
 */

import { composeAgentBody } from "./body.js";
import type { AgentJobSpec } from "./types.js";

export const LUDIARS_STATUS_DAILY_JOB = "ludiars-status-daily";

export interface ServiceStatusItem {
  code: string;
  name: string;
  project: string | null;
  state: "up" | "down" | "unknown" | "unmonitored";
  /** 本社 (Cc 自身の拠点) の観測か。 拠点名は渡さない。 */
  self: boolean;
}

export interface LudiarsStatusSources {
  services(): Promise<ServiceStatusItem[]>;
  lastDoneSummary(job: string): string | null;
}

/** 止まっているものほど先 (上限超過で落ちるのは末尾の監視外から)。 */
const STATE_ORDER: Record<ServiceStatusItem["state"], number> = { down: 0, unknown: 1, up: 2, unmonitored: 3 };

export function createLudiarsStatusDailyJob(sources: LudiarsStatusSources): AgentJobSpec {
  return {
    jobName: LUDIARS_STATUS_DAILY_JOB,
    resultKind: "要約",
    body: composeAgentBody([
      "LUDIARS 公開サービスの稼働状況の日報の要約を作る回です。",
      "",
      "params.data.services (code・名前・状態・本社の観測か) と前回の要約 (previous_summary) を見比べ、",
      "止まっているサービス・状態の変わったサービス・確認できなかったサービスを先に挙げてください。",
      "状態が unknown のものは「取得できず」と書き、 稼働しているとみなさないでください。",
    ]),
    async buildData(context) {
      const services = (await sources.services())
        .slice()
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.code.localeCompare(b.code))
        .map(({ code, name, project, state, self }) => ({ code, name, project, state, self }));
      return {
        date: context.args.date ?? null,
        previous_summary: sources.lastDoneSummary(LUDIARS_STATUS_DAILY_JOB),
        services,
      };
    },
  };
}
