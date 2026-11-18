/**
 * FU-INVESTIGATE: 進捗率と観測された動きが前回の自動確認から変わらないときに送る「原因調査モード」の本文。
 * セッションに「人間の指示待ち」「作業完了」「作業が残っている」のどれかを決めさせ、
 * 作業完了なら ask マーカーで人間にセッション終了を提案させる。Cc はセッションを終了させない。
 *
 * @implements spec/feature/autonomous-work-continuation.md FU-INVESTIGATE
 */
import { renderProgressRate } from "./followup-progress-rate.js";

export function renderFollowupInvestigation(rate: number | null, unchangedCount: number): string[] {
  return [
    `[原因調査モード] ${renderProgressRate(rate)} — 前回の自動確認から進捗率も観測できる動きも変わっていません (連続 ${unchangedCount} 回)。`,
    "止まっている原因を調べ、次のどれか 1 つに決めて行動してください。`[変化なし]` だけで返さないでください。",
    "1. 人間の指示待ち: 人間に決めてもらうことがある → ask マーカーで質問を出すか、human-wait を記録して待機する。",
    "2. 作業完了: 依頼された作業・反映・後片付けがすべて済んでいる → ask マーカーで人間にセッション終了を提案する (選択肢: 終了する / 続ける)。回答が来るまで session-end しない。",
    "3. 進められる作業が残っている → 止まっていた原因を 1 行で書き、その作業を進める。",
    "判断の根拠 (Actio タスクの状態・PR の状態・反映の確認結果) を短く添えてください。unknown を完了と推測しないでください。",
  ];
}
