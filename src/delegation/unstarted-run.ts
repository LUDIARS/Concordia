/**
 * @implements spec/tasks/2026-08-08-delegation-run-watchdog.md
 *
 * 委託 run の「未着手」判定 — spawn したのに委託プロンプトが一度も入力されなかった run を拾う。
 *
 * Lictor の auto-inject (`src/delegation-inject.ts`) は wrapped CLI の TUI へ prompt を
 * 1 回 paste する。 TUI がまだ入力を受け付けていない時点で paste すると本文ごと落ち、
 * セッションは「起動しただけ・入力欄は空」のまま止まる。 このとき:
 *
 *   - run.status は `running` のまま (終わらないので queue も空かない)
 *   - 子セッションは `active`、 last_seen_at も現在時刻 (Lictor の心拍は動いている)
 *   - transcript_logs は **0 行** (ターンが 1 度も回っていない唯一の観測可能な差)
 *
 * run-watchdog の idle 判定は「最終活動時刻」を transcript_logs の MAX(ts) で測るため、
 * 0 行の run は活動時刻が null になり判定から外れていた (2026-09-04 に 3.5 時間放置が実測)。
 * 一番助けが要る状態だけが監視の外に落ちるので、 ここで spawn からの経過時間を代替の
 * 基準にして拾う。
 *
 * 判断は純関数に閉じる (run-watchdog 側は I/O と通知だけを持つ)。
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";

/** 未着手とみなすまでの既定待ち時間 (秒)。 起動 + 初回描画 + inject 遅延の合計に余裕を見る。 */
export const DEFAULT_UNSTARTED_SEC = 300;

/** 未着手検知の走査周期 (ms)。 idle 判定 (既定 30 分) より短く回す必要があるため別に持つ。 */
export const UNSTARTED_SCAN_INTERVAL_MS = 120_000;

export interface UnstartedDecisionInput {
  /** run の作成時刻 (epoch-ms)。 spawn 時刻の代理。 */
  createdAtMs: number;
  nowMs: number;
  /** 未着手とみなすまでの閾値 (ms)。 */
  thresholdMs: number;
  /** 直近の自動確認時刻 (epoch-ms)。 null = 未実施。 */
  lastNudgeMs: number | null;
}

/**
 * 「spawn から thresholdMs 以上経っても transcript が 1 行も無い」 かを判定する。
 * 再送の間隔も thresholdMs で抑える (同じ run へ連打しない)。
 */
export function shouldReinjectUnstarted(input: UnstartedDecisionInput): boolean {
  if (!(input.thresholdMs > 0)) return false;
  if (input.nowMs - input.createdAtMs < input.thresholdMs) return false;
  if (input.lastNudgeMs != null && input.nowMs - input.lastNudgeMs < input.thresholdMs) return false;
  return true;
}

/**
 * 未着手 run へ送り直す本文。 委託プロンプト全文ではなく prompt file を読ませる誘導にする —
 * 本文は数千字あり、 落ちた原因が TUI の受け取り損ねである以上、 短い方が届く確率が高い。
 * prompt file が無い run (手動 invoke 等) では rendered_prompt を持っているので、
 * その旨だけ伝えて委託元へ問い合わせさせる。
 */
export function buildUnstartedInjectText(run: DelegationRunRow): string {
  const head = [
    `[delegation:${run.id}] [自動確認] 委託プロンプトが届いていません (このセッションはまだ 1 ターンも実行していません)。`,
    "",
  ];
  const body = run.prompt_file_path
    ? [
      `1. \`${run.prompt_file_path}\` を読み、 その本文を依頼の全文として扱ってください。`,
      "2. 本文に書かれた手順だけを実行し、 書かれていない手順を足さないでください。",
      `3. 完了・失敗いずれの場合も POST /v1/delegation/runs/${run.id}/status で報告してから終わってください。`,
    ]
    : [
      "委託プロンプトのファイルが残っていません。 現在の状況を 1 行で報告し、",
      `POST /v1/delegation/runs/${run.id}/status で failed を報告して終わってください。`,
    ];
  return [...head, ...body].join("\n");
}
