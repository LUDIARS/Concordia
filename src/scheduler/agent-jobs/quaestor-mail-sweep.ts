import { buildQuaestorMailSweepArgs } from "../cron-jobs.js";
import { composeAgentBody } from "./body.js";
import type { MailSweepData } from "./quaestor-mail-sweep-data.js";
import type { AgentJobSpec } from "./types.js";

export const QUAESTOR_MAIL_SWEEP_JOB = "quaestor-mail-sweep";

export interface MailSweepSources {
  prepareMailSweep(dedupeKey: string): Promise<MailSweepData | null>;
}

export function createQuaestorMailSweepJob(sources: MailSweepSources): AgentJobSpec {
  return {
    jobName: QUAESTOR_MAIL_SWEEP_JOB,
    resultKind: "報告",
    body: composeAgentBody([
      "本社 Cc による Quaestor メール取り込みの結果を報告してください。",
      "実行枠・日付、取り込み状態と分類別件数、確定・要確認・通知件数をまとめてください。",
      "要確認 ID は一覧取得時点の既存分を含みます。失敗・結果不明・無効化・取得できなかった ID はその旨を示してください。",
      "エラーはメッセージ ID と種別だけにし、rate_limit / auth は次回に回す旨を示してください。",
      "sweep_status が crawler のときは、取り込みは Quaestor の常駐巡回が行っています (手動の取り込みは断られます)。crawler の ready・pending・processed・failures・last_failure・backfill を報告してください。",
      "last_failure.category が認証系 (auth を含むもの) で failures が増えているなら、人間の再認証が要る点として summary の先頭に書いてください。",
    ]),
    prepare: async (dedupeKey) => {
      const result = await sources.prepareMailSweep(dedupeKey);
      return result === null ? null : { ...result };
    },
    buildData: async ({ firedAt }, prepared) => {
      if (!prepared) throw new Error("mail sweep result is missing");
      return { ...buildQuaestorMailSweepArgs(firedAt), ...prepared };
    },
  };
}
