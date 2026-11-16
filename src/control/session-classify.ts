/**
 * セッションを観測された動きから 1 つの分類に振り分ける純関数 (2026-11-17 neco 指示
 * 「進捗確認のやり方を根本的に見直せ」)。管制のボード・追加指示・まとめは全部この分類を読む。
 *
 * 旧基準 (自動確認の「変化なし」回数 unchanged_count>=2) は使わない。自動確認が送られない・
 * 指紋が無いセッションでも、最終活動と待つ理由だけで止まっているかが決まる
 * (全員が無活動なのに停止 0 件、にはならない)。
 *
 * 優先順: 人間の判断待ち → 審査・委託の結果待ち → 作業中 (直近 20 分に活動) → 終了候補 → 応答なし → 停止。
 *
 * @implements spec/feature/control-session.md §2
 */

export type SessionActivityStatus =
  | "working"
  | "human_wait"
  | "awaiting_result"
  | "end_candidate"
  | "unresponsive"
  | "stalled";

/** この時間より長く活動が無く、待つ理由も無ければ停止。 */
export const STALL_IDLE_SEC = 20 * 60;
/** 届いた追加指示にこの回数反応が無ければ応答なし。 */
export const UNRESPONSIVE_NUDGE_MIN = 3;

export const SESSION_STATUS_LABEL: Record<SessionActivityStatus, string> = {
  working: "作業中",
  human_wait: "人間の判断待ち",
  awaiting_result: "審査・委託の結果待ち",
  end_candidate: "終了候補",
  unresponsive: "応答なし",
  stalled: "停止",
};

/** 分類の表示順 (まとめ・件数)。 */
export const SESSION_STATUS_ORDER: readonly SessionActivityStatus[] = [
  "stalled", "unresponsive", "human_wait", "awaiting_result", "end_candidate", "working",
];

export interface SessionClassifyInput {
  /** 最後の活動からの経過秒。観測できなければ null。 */
  idleSec: number | null;
  /** 人間の判断待ちの理由 (質問カード・human-wait・ask など)。待っていなければ null。 */
  humanWait: string | null;
  /** 結果を待っている対象 (審査中 PR・実行中の委託)。無ければ null。 */
  awaitingResult: string | null;
  /** 未コミットの変更があるか。確かめられなければ null。 */
  uncommitted: boolean | null;
  /** 担当作業が終わった根拠 (担当 PR マージ済み・依頼完了)。無ければ null。 */
  workDone: string | null;
  /** 最後の活動以降に届けた追加指示の数。 */
  unansweredNudges: number;
  /** 届けたはずの追加指示が会話に現れていない (inject が会話に入っていない疑い)。 */
  injectUnreflected: boolean;
  /** 待つ理由を確かめられず無活動基準に戻した注記 (審査状況の読み取り打ち切り)。 */
  reviewNote?: string | null;
}

export interface SessionClassification {
  status: SessionActivityStatus;
  reason: string;
}

function idleMinutes(idleSec: number): number {
  return Math.floor(idleSec / 60);
}

export function classifySession(input: SessionClassifyInput): SessionClassification {
  if (input.humanWait) return { status: "human_wait", reason: input.humanWait };
  if (input.awaitingResult) return { status: "awaiting_result", reason: input.awaitingResult };
  if (input.idleSec === null) return { status: "working", reason: "最終活動を観測できない (起動直後など)" };
  if (input.idleSec < STALL_IDLE_SEC) return { status: "working", reason: `直近 ${idleMinutes(input.idleSec)} 分前に活動` };
  const idle = [`無活動 ${idleMinutes(input.idleSec)} 分`, input.reviewNote ?? null]
    .filter((part): part is string => part !== null).join(" / ");
  if (input.workDone && input.uncommitted === false) return { status: "end_candidate", reason: `${input.workDone} / ${idle}` };
  if (input.injectUnreflected) {
    return { status: "unresponsive", reason: `追加指示が会話に入っていない疑い / ${idle}` };
  }
  if (input.unansweredNudges >= UNRESPONSIVE_NUDGE_MIN) {
    return { status: "unresponsive", reason: `追加指示 ${input.unansweredNudges} 回に反応なし / ${idle}` };
  }
  const notes = [
    "待つ理由なし",
    idle,
    input.uncommitted ? "未コミットの変更あり" : null,
    input.unansweredNudges > 0 ? `追加指示 ${input.unansweredNudges} 回に未反応` : null,
  ].filter((part): part is string => part !== null);
  return { status: "stalled", reason: notes.join(" / ") };
}
