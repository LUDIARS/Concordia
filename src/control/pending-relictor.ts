/**
 * `/co-relictor` (文脈引き継ぎ Lictor 再起動) の spawn と、 その後 Lictor が独立に
 * 登録する新セッションを結びつける一時レジストリ (プロセス内メモリ)。
 *
 * 背景: Lictor は claude を pty 子として抱えるため、 Lictor 単体の再 exec はできない
 * (子 pty を巻き添えにする)。 そこで「最新版で再起動」= ラップ中セッションごと再起動:
 *   1. 引き継ぎ資料 (handoff) を生成しチャンネルへ投稿。
 *   2. cwd をキーに handoff + goal をここへ記録。
 *   3. 新セッションを spawn (= 最新 Lictor dist)。 旧セッションは force-exit。
 *   4. 新セッションが POST /v1/sessions で登録された時 (session.started)、 cwd 一致で
 *      claim し、 goal を引き継ぎ・handoff を inject して文脈を復元する。
 *
 * pending-delegation-spawns と同じ cwd 照合・TTL。 別レジストリにして delegation の
 * emoji 焼き込みと混線しないようにする。
 */

import type { Goal } from "./goal.js";

const TTL_MS = 5 * 60 * 1000; // 5 分で expire (取り違え防止)

export interface PendingRelictor {
  cwd: string;
  /** 引き継ぎ資料 (markdown)。 新セッションへ inject する。 */
  handoff: string;
  /** 旧セッションのゴール。 新セッション metadata に引き継ぐ。 */
  goal: Goal | null;
  at: number;
}

const pending: PendingRelictor[] = [];

/** relictor spawn 直後に呼ぶ。 cwd が空なら記録しない (照合に使えないため)。 */
export function recordPendingRelictor(
  input: { cwd?: string | null; handoff: string; goal?: Goal | null },
  now = Date.now(),
): void {
  const cwd = (input.cwd ?? "").trim();
  if (!cwd) return;
  pending.push({ cwd: normalize(cwd), handoff: input.handoff, goal: input.goal ?? null, at: now });
  prune(now);
}

/**
 * session.started で呼ぶ。 repo_path に対応する pending relictor を 1 件 claim して返す。
 * 照合: cwd 完全一致 → cwd が repo_path の祖先、 の順。 同条件は最新優先。 無ければ null。
 */
export function claimPendingRelictor(repoPath: string | null | undefined, now = Date.now()): PendingRelictor | null {
  prune(now);
  const rp = normalize((repoPath ?? "").trim());
  if (!rp) return null;
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    let score = -1;
    if (p.cwd === rp) score = 2;
    else if (rp.startsWith(`${p.cwd}/`)) score = 1;
    if (score < 0) continue;
    if (score > bestScore || (score === bestScore && (bestIdx < 0 || p.at > pending[bestIdx].at))) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const [claimed] = pending.splice(bestIdx, 1);
  return claimed;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function prune(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].at > TTL_MS) pending.splice(i, 1);
  }
}

/** テスト用: レジストリを空にする。 */
export function _resetPendingRelictor(): void {
  pending.length = 0;
}
