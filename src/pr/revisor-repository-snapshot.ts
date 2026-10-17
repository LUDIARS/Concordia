// Revisor 登録一覧の stale-while-revalidate スナップショット (表示用)。
// @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
//
// GET /v1/project-codes/admin は Actio のプロジェクト同期 (timeout 10s) と管理 UI が叩く。
// 毎回 Excubitor の service 照会 + Revisor 往復を待つと 0.1〜6 秒ぶれるため、表示用途は
// 直近の成功結果を即返し、古ければ裏で 1 本だけ取り直す。
// push 可否の判定 (session-push-check / register-core) は誤判定が許されないので使わない。
import type { RevisorRepositoryAdmin, RevisorRepositoryRecord } from "./revisor-repository-client.js";

/** これより新しければ取り直さない。 */
const DEFAULT_FRESH_MS = 30_000;
/** これより古い成功結果は表示に使わず unknown (null) とする。 */
const DEFAULT_MAX_STALE_MS = 5 * 60_000;
/** キャッシュ未取得時に初回取得を待つ上限。 応答予算 100ms の内側に収める。 */
const DEFAULT_COLD_WAIT_MS = 50;

export interface RevisorRepositorySnapshot {
  /** 直近の一覧 (古ければ裏で更新)。 null = Revisor の状態が分からない。 */
  read(): Promise<RevisorRepositoryRecord[] | null>;
  /**
   * 書き込み後に古い一覧を捨てる。 古い一覧を返すと admin 表示の書き戻し (setRevisorWorkflow)
   * が変更直後の workflow を上書きするため、 stale 扱いでなく破棄する。
   */
  invalidate(): void;
}

interface SnapshotOptions {
  freshMs?: number;
  maxStaleMs?: number;
  coldWaitMs?: number;
  now?: () => number;
}

export function createRevisorRepositorySnapshot(
  source: Pick<RevisorRepositoryAdmin, "listRepositories">,
  options: SnapshotOptions = {},
): RevisorRepositorySnapshot {
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const coldWaitMs = options.coldWaitMs ?? DEFAULT_COLD_WAIT_MS;
  const now = options.now ?? Date.now;
  let cached: { list: RevisorRepositoryRecord[]; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  // invalidate より前に出た取得の結果 (変更前の一覧) を採用しないための世代。
  let generation = 0;

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    const started = generation;
    const request: Promise<void> = source.listRepositories()
      .then((list) => { if (started === generation) cached = { list, at: now() }; })
      // 失敗は前回の成功結果を残す。 maxStaleMs を過ぎれば read が unknown を返す。
      .catch(() => undefined)
      .finally(() => { if (inflight === request) inflight = null; });
    inflight = request;
    return request;
  };

  const usable = () => (cached && now() - cached.at <= maxStaleMs ? cached.list : null);

  return {
    async read() {
      if (!cached) {
        // 初回だけは短く待つ。 待ち切れなければ unknown で返し、取得は裏で続ける。
        await Promise.race([refresh(), delay(coldWaitMs)]);
        return usable();
      }
      if (now() - cached.at > freshMs) void refresh();
      return usable();
    },
    invalidate() {
      generation += 1;
      cached = null;
      inflight = null;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
