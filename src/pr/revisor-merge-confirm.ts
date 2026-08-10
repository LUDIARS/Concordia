/**
 * マージ要求の前後で Revisor 側の実状態を読み直す。
 *
 * マージは「要求が通ったか」ではなく「PR がマージされたか」で判定すべきもので、
 * 両者は次の 2 つの場面でずれる。
 *
 * - **要求より先に auto-merge が成立していた** — Revisor は Test OK 到達時点で
 *   リスク閾値を満たせば自分でマージする。 後から届いた明示マージは拒否されるが、
 *   利用者から見れば目的は達成されている。 2026-08-10 の Revisor#395 が実例。
 * - **打ち切ったが Revisor は完走した** — Concordia が待ち切れずに接続を切っても
 *   Revisor のマージ処理は止まらない。 2026-08-10 の Peregrinatio#408 が実例。
 *
 * どちらも「失敗」と報告すると、 実際には main に入っている変更を追いかけ直す
 * ことになる。 状態を読めば区別できる。
 */

import type { RevisorLocalPr, RevisorLocalPrReader } from "./revisor-client.js";

/** Revisor 側でマージ済みを表す status。 */
const MERGED = "merged";

/**
 * id で local PR を 1 件引く。 Revisor は id 指定の取得口を公開していないので一覧から選ぶ。
 * 読めなかった場合は null — 状態を確認できないことと「存在しない」ことは区別しない
 * (どちらも「確定できない」として扱う)。
 */
export async function findLocalPrById(
  reader: Pick<RevisorLocalPrReader, "listLocalPrs">,
  id: string,
): Promise<RevisorLocalPr | null> {
  try {
    const all = await reader.listLocalPrs();
    return all.find((pr) => pr.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * 対象 PR が既にマージ済みかを返す。
 *
 * 読み取りに失敗したときは `false` を返す — 「確認できなかった」を「マージ済み」へ
 * 寄せると、 未マージの PR をマージ済みと報告してしまう。 ここは fail-closed にする。
 */
export async function isAlreadyMerged(
  reader: Pick<RevisorLocalPrReader, "listLocalPrs"> | undefined,
  id: string,
): Promise<boolean> {
  if (!reader) return false;
  const pr = await findLocalPrById(reader, id);
  return pr?.status === MERGED;
}
