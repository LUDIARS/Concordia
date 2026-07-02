/**
 * Discord relay の単一所有権 lease。
 *
 * backend 内蔵 bot (embedded) と discord-worker が同一 token で同時に動くと、
 * 同じ interaction を二重 dispatch して片方が 40060/10062 になり、 /spawn が
 * 二重実行される (2026-07-01 worker 分離後の spawn 不安定の主因)。
 * env (CONCORDIA_DISCORD_EMBEDDED=0) の設定漏れだけに頼らず、 DB 上の lease で
 * 「worker が生きていれば embedded は退く」 を機械的に保証する:
 *  - worker: 起動時に lease を書き、 RELAY_HEARTBEAT_MS ごとに heartbeat を更新。
 *  - embedded: 起動時に live な worker lease があれば起動しない。 起動後も
 *    RELAY_CHECK_MS ごとに確認し、 worker が現れたら自ら停止する (worker 優先)。
 */

import type { DiscordConfigRepo } from "../db/discord-repo.js";

const KEY = "relay_owner_lease";
/** これより古い heartbeat の lease は死んだ worker とみなす。 */
export const RELAY_LEASE_TTL_MS = 90_000;
/** worker が heartbeat を更新する間隔。 */
export const RELAY_HEARTBEAT_MS = 30_000;
/** embedded が worker lease の出現を確認する間隔。 */
export const RELAY_CHECK_MS = 15_000;

export interface RelayLease {
  kind: "worker";
  pid: number;
  ts: number;
}

/** live な worker lease を返す (無い / 期限切れ / 壊れている → null)。 */
export function readWorkerLease(repo: DiscordConfigRepo, now: number = Date.now()): RelayLease | null {
  const raw = repo.get(KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<RelayLease>;
    if (o.kind === "worker" && typeof o.pid === "number" && typeof o.ts === "number" && now - o.ts < RELAY_LEASE_TTL_MS) {
      return { kind: "worker", pid: o.pid, ts: o.ts };
    }
  } catch {
    // 壊れた lease は無効扱い (次の heartbeat で上書きされる)
  }
  return null;
}

/** worker 側: lease を取得し heartbeat を打ち続ける。 stop() で lease を明示解放。 */
export function startWorkerLease(
  repo: DiscordConfigRepo,
  opts: { pid?: number; now?: () => number } = {},
): { stop(): void } {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const beat = () => {
    try {
      repo.set(KEY, JSON.stringify({ kind: "worker", pid, ts: now() } satisfies RelayLease));
    } catch {
      /* DB 一時失敗は次の beat に任せる (lease は TTL 内なら有効なまま) */
    }
  };
  beat();
  const timer = setInterval(beat, RELAY_HEARTBEAT_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      try {
        repo.delete(KEY);
      } catch {
        /* best-effort: 消せなくても TTL で失効する */
      }
    },
  };
}
