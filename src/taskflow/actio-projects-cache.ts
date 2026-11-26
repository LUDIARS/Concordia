/**
 * Actio のプロジェクト登録 (GET /api/projects/cc) を短時間だけ覚える。
 *
 * タスクの読み書きのたびに binding を解くため一覧を取り直していて、委託の子が本文を取る
 * GET /v1/taskflow/tasks/content が 1〜4.7 秒かかっていた (2026-11-26 実測。一覧は約 14 KB・0.5 秒)。
 * 一覧はプロジェクトの登録時にしか変わらないので、短い有効期限で使い回す。
 * - 同時に来た読み取りは 1 回の取得を共有する。
 * - 失敗は覚えない (次の読み取りで取り直す)。
 */

export const ACTIO_PROJECTS_CACHE_TTL_MS = 30_000;

export function cachedActioProjects<T>(
  load: () => Promise<T>,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<T> {
  const ttlMs = options.ttlMs ?? ACTIO_PROJECTS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    const started = now();
    inFlight = load()
      .then((value) => { cached = { value, at: started }; return value; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}
