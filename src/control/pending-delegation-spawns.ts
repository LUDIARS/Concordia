// delegation invoke の spawn と、その後 Lictor が独立に登録するセッションを
// 結びつけるための一時レジストリ（プロセス内メモリ）。
//
// 背景: `/co-spawn`（delegation）は wt.exe ターミナルを起動し、その中の Lictor が
// **別途** Concordia にセッション登録する（POST /v1/sessions）。spawn 時点では
// session_id が未確定なため、delegation テンプレの絵文字をセッションに直接焼けない。
// そこで spawn 時に (cwd, emoji, call_name) を覚えておき、session.started 受信時に
// cwd 一致で claim → セッション metadata に emoji を焼く。マッチは数秒以内に起きる
// 想定なので in-memory で十分（再起動で失っても既定アイコンに戻るだけ）。

const TTL_MS = 5 * 60 * 1000; // 5 分でexpire（取り違え防止）

export interface PendingDelegationSpawn {
  cwd: string;
  emoji: string | null;
  callName: string;
  runId: string | null;
  /** 子会社由来の spawn なら子会社 id。 session.started 時に metadata.subsidiary_id へ焼く。 */
  subsidiaryId: string | null;
  /** project 限定 spawn ならプロジェクト名。 session.started 時に metadata.project へ焼く。 */
  project: string | null;
  /** Parent session that requested the delegation, when known. */
  parentSessionId: string | null;
  /** Whether the spawned session opted in to goal-and-go autonomous continuation. */
  goalAndGo: boolean;
  at: number;
}

const pending: PendingDelegationSpawn[] = [];

/** spawn 前後に呼ぶ。cwd が空なら記録しない（照合に使えないため）。 */
export function recordPendingDelegationSpawn(
  input: {
    cwd?: string | null;
    emoji?: string | null;
    callName: string;
    runId?: string | null;
    subsidiaryId?: string | null;
    project?: string | null;
    parentSessionId?: string | null;
    goalAndGo?: boolean;
  },
  now = Date.now(),
): void {
  const cwd = (input.cwd ?? "").trim();
  if (!cwd) return;
  pending.push({
    cwd: normalize(cwd),
    emoji: (input.emoji ?? "").trim() || null,
    callName: input.callName,
    runId: (input.runId ?? "").trim() || null,
    subsidiaryId: (input.subsidiaryId ?? "").trim() || null,
    project: (input.project ?? "").trim() || null,
    parentSessionId: (input.parentSessionId ?? "").trim() || null,
    goalAndGo: input.goalAndGo === true,
    at: now,
  });
  prune(now);
}

/**
 * session.started で呼ぶ。repo_path に対応する pending spawn を 1 件 claim して返す。
 * マッチ規則: cwd 完全一致 → cwd が repo_path の祖先（AI が cwd 配下へ移動した場合）の順。
 * 同条件が複数あれば最新を採る。見つからなければ null。
 */
export function claimPendingDelegationSpawn(repoPath: string | null | undefined, now = Date.now()): PendingDelegationSpawn | null {
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
    // 同スコアは最新（at 大）優先。スコア優先。
    if (score > bestScore || (score === bestScore && (bestIdx < 0 || p.at > pending[bestIdx].at))) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const [claimed] = pending.splice(bestIdx, 1);
  return claimed;
}

export function forgetPendingDelegationSpawnByRunId(runId: string | null | undefined): void {
  const rid = (runId ?? "").trim();
  if (!rid) return;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].runId === rid) pending.splice(i, 1);
  }
}

/** パス区切りを `/` に正規化し末尾スラッシュを除去（Windows の `\` を吸収）。 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function prune(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].at > TTL_MS) pending.splice(i, 1);
  }
}

/** テスト用: レジストリを空にする。 */
export function _resetPendingDelegationSpawns(): void {
  pending.length = 0;
}
