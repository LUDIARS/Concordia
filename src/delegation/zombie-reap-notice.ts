/**
 * 残留プロセス回収 (ゾンビ委託) の通知文を組み立てる (純関数)。
 *
 * 回収は明示的に有効化したときだけ走る破壊的操作なので、 実行したことは黙って
 * ログに流さず、 管理者へ 1 通で知らせる。
 *
 * ## メンションは管理者 1 人だけ (neco 指示 2026-09-05)
 *
 * 宛先は `admin.mention_user_id` だけにする。 回収対象の run には元の指示者や
 * supervisor が紐づいているが、 それらを引いて足すと 1 回の掃除で無関係な人が
 * まとめて呼ばれる。 掃除は管理者の関心事であって、 委託を出した人の関心事ではない。
 *
 * メンションは本文へ `<@id>` を書かず、 呼び出し側が `mention_user_ids` の
 * 構造化フィールドで渡す。 egress は `allowedMentions: { parse: [] }` を付けて送るため、
 * 本文に紛れた文字列は発火しない。 ここが本文組み立てだけを担当するのはそのため。
 *
 * SRP: 文面の組み立てのみ。 chat への投函・メンション ID の解決は呼び出し側。
 */

import type { ReapResult } from "./finished-run-reaper.js";

/** 1 通に並べる行数の上限。 これを超えた分は件数だけ示す。 */
const MAX_LISTED = 10;

/**
 * 回収結果の通知文を返す。 停止を 1 件も試みていなければ null (通知しない)。
 *
 * 本文に載せるのは Cc 自身が持つ値 (run id / pid / status / 経過時間) だけで、
 * 委託の指示文やユーザ入力は載せない。
 */
export function buildZombieReapNotice(results: readonly ReapResult[]): string | null {
  if (results.length === 0) return null;
  const stopped = results.filter((r) => r.stop.ok);
  const failed = results.filter((r) => !r.stop.ok);

  const lines: string[] = [];
  lines.push(
    `終了済み委託の残留プロセスを ${stopped.length} 件停止しました`
    + (failed.length > 0 ? ` (${failed.length} 件は停止に失敗)。` : "。"),
  );

  const listed = results.slice(0, MAX_LISTED);
  for (const result of listed) {
    const { zombie } = result;
    const hours = Math.round(zombie.lingering_ms / 3_600_000 * 10) / 10;
    // stop.error may contain OS/process details such as local paths. The internal
    // reaper log already records it; the externally relayed system chat must not.
    const outcome = result.stop.ok ? "停止" : "失敗";
    lines.push(`- run ${shortId(zombie.run_id)} / pid ${zombie.lictor_pid} / ${zombie.status} / 残留 ${hours}h → ${outcome}`);
  }
  if (results.length > listed.length) {
    lines.push(`- ほか ${results.length - listed.length} 件`);
  }
  return lines.join("\n");
}

/** run id は先頭 8 文字で足りる (Cc の run 一覧と同じ見え方)。 */
function shortId(runId: string): string {
  return runId.slice(0, 8);
}
