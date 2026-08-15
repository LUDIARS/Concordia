/**
 * `/co-relictor` (文脈引き継ぎ Lictor 再起動) の spawn と、 その後 Lictor が独立に
 * 登録する新セッションを結びつける一時レジストリ (プロセス内メモリ)。
 *
 * 背景: Lictor は claude を pty 子として抱えるため、 Lictor 単体の再 exec はできない
 * (子 pty を巻き添えにする)。 そこで「最新版で再起動」= ラップ中セッションごと再起動:
 *   1. 引き継ぎ資料 (handoff) を生成しチャンネルへ投稿。
 *   2. spawn ID をキーに handoff + goal をここへ記録 (cwd は旧 caller 用 fallback)。
 *   3. 新セッションを spawn (= 最新 Lictor dist)。 旧セッションは force-exit。
 *   4. 新セッションが POST /v1/sessions で登録された時 (session.started)、 spawn ID 一致で
 *      claim し、 goal を引き継ぎ・handoff を inject して文脈を復元する。
 *
 * pending-delegation-spawns と同じ enrollment ID・TTL。 別レジストリにして delegation の
 * emoji 焼き込みと混線しないようにする。
 */

import type { Goal } from "./goal.js";

const TTL_MS = 5 * 60 * 1000; // 5 分で expire (取り違え防止)

/**
 * 引き継ぎの種別。 relictor = 最新 Lictor での再起動、 handover = 次セッションへの
 * 作業移行 (/co-handover)。 機構は同一で、 新セッションへの再投入文言だけが変わる。
 */
export type PendingRelictorKind = "relictor" | "handover";

export interface PendingRelictor {
  cwd: string;
  /** spawn と SessionStart を一意に結ぶ enrollment ID。旧 caller のみ null。 */
  spawnId: string | null;
  /** 引き継ぎ資料 (markdown)。 新セッションへ inject する。 */
  handoff: string;
  /** 旧セッションのゴール。 新セッション metadata に引き継ぐ。 */
  goal: Goal | null;
  kind: PendingRelictorKind;
  at: number;
}

const pending: PendingRelictor[] = [];

/** relictor / handover spawn 直前に呼ぶ。 cwd が空なら記録しない。 */
export function recordPendingRelictor(
  input: {
    cwd?: string | null;
    spawnId?: string | null;
    handoff: string;
    goal?: Goal | null;
    kind?: PendingRelictorKind;
  },
  now = Date.now(),
): void {
  const cwd = (input.cwd ?? "").trim();
  if (!cwd) return;
  pending.push({
    cwd: normalize(cwd),
    spawnId: (input.spawnId ?? "").trim() || null,
    handoff: input.handoff,
    goal: input.goal ?? null,
    kind: input.kind ?? "relictor",
    at: now,
  });
  prune(now);
}

/**
 * session.started で呼ぶ。enrollment ID があれば ID + cwd で照合し、cwd だけへは
 * フォールバックしない。同 cwd の並行 spawn や enrollment ID 漏洩時の handoff 横取りを防ぐ。
 * ID が無い旧 caller だけ cwd 完全一致 → 祖先一致で照合する。
 */
export function claimPendingRelictor(
  repoPath: string | null | undefined,
  now = Date.now(),
  spawnId?: string | null,
): PendingRelictor | null {
  prune(now);
  const id = (spawnId ?? "").trim();
  if (id) {
    const rp = normalize((repoPath ?? "").trim());
    if (!rp) return null;
    const index = pending.findIndex((item) => item.spawnId === id && item.cwd === rp);
    return index >= 0 ? pending.splice(index, 1)[0] : null;
  }
  const rp = normalize((repoPath ?? "").trim());
  if (!rp) return null;
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    if (p.spawnId) continue;
    let score = -1;
    if (p.cwd === rp) score = 2;
    else if (isSameOrDescendantPath(p.cwd, rp)) score = 1;
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

/** 同期 spawn 失敗時に、後続の別セッションへ handoff が誤投入されないよう破棄する。 */
export function forgetPendingRelictorBySpawnId(spawnId: string | null | undefined): void {
  const id = (spawnId ?? "").trim();
  if (!id) return;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].spawnId === id) pending.splice(i, 1);
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
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
