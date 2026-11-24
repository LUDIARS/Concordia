import { jstMinute } from "../agent-dispatch-policy.js";
import { composeAgentBody } from "./body.js";
import type { AgentJobSpec } from "./types.js";
import { contract } from '../ontime-runtime.js'; /* augur-inject:import:30d41798 */
import augurContract_afcf4a51 from './kaizen-daily.contract.js'; /* augur-inject:contract-predicate:9872f15f */

export const KAIZEN_DAILY_JOB = "kaizen-daily";
const DAY_MS = 86_400_000;

export interface KaizenDay {
  date: string;
  start: Date;
  end: Date;
}

export interface KaizenFacts {
  failed_runs: { call_name: string; reason: string; count: number }[];
  failed_cron_jobs: { job: string; count: number }[];
  human_waiting: number;
  /** null means the requeue counter was introduced after the start of this day. */
  instruction_requeues: number | null;
  hook_denials: { kind: string; count: number }[];
}

export interface KaizenSources {
  kaizenFacts(day: KaizenDay): KaizenFacts;
  kaizenProjectCodes?(): string[];
}

export function previousKaizenDay(firedAt: Date): KaizenDay {
  const end = new Date(`${jstMinute(firedAt).slice(0, 10)}T00:00:00+09:00`);
  const start = new Date(end.getTime() - DAY_MS);
  return { date: jstMinute(start).slice(0, 10), start, end };
}
// @ts-expect-error augur-inject
previousKaizenDay = contract(previousKaizenDay, { ...augurContract_afcf4a51, contractId: 'cron-mail-kaizen-C-42', mode: 'observe', sample: 1, where: 'src/scheduler/agent-jobs/kaizen-daily.ts:27', rule: 'contract-wrap', id: 'afcf4a51' }); /* augur-inject:contract-wrap:afcf4a51 */

export function createKaizenDailyJob(sources: KaizenSources): AgentJobSpec {
  return {
    jobName: KAIZEN_DAILY_JOB,
    resultKind: "提案",
    body: composeAgentBody([
      "前日 JST の失敗・停滞の集計を読み、根拠の件数と改善の提案を返してください。",
      "根拠が足りない場合は不足を示してください。実装、委託、タスク作成は行わないでください。",
      "dots は detail.proposals に提案を最大 20 件、優先順で返してください。detail.items の報告用の文字列も残してください。",
      "各提案の形式は {title, reason, target_repo, kind, instruction?} です。title は120文字、根拠を含む reason は500文字までです。",
      "target_repo は材料にある project_codes のプロジェクトコードを指定してください。根拠から対象を決められなければ detail.items に不足を記してください。",
      "既存リポ内で完結する保守・修正は kind=cloud_fix とし、instruction に具体的な実装指示を3000文字以内で入れてください。",
      "方針や権限など人間の判断が要るものは kind=human_judgment とし、判断点を reason に入れてください。",
    ]),
    buildData: async ({ firedAt }) => {
      const day = previousKaizenDay(firedAt);
      return { date: day.date, ...sources.kaizenFacts(day), project_codes: sources.kaizenProjectCodes?.() ?? [] };
    },
  };
}
