/**
 * Repo change watcher.
 *
 * eventBus の `stat.collected` を subscribe し、 stat 投稿時点の
 * sessions.repo_path がこのセッションの直近観測値と変わっていれば、
 * 「現在の作業のサマリを 30 文字以内」 で要約させる `title-suggest`
 * pending task を 1 件 enqueue する.
 *
 * AI 側はサマリを生成して
 *   POST /v1/sessions/:id/title-suggestion { text: "..." }
 * に投稿する. 受信側 (api/sessions.ts) が Lictor の /v1/rename に
 * 転送して OSC タイトル + Claude 側 session name を更新する.
 *
 * 初回 stat (cache miss) は repo_path を覚えるだけで enqueue しない —
 * 立ち上げ直後に毎セッションへタイトル質問を飛ばしてしまうのを避ける.
 *
 * dedup:
 *  - 同 lastSeenRepoPath が連続して観測されている間は何もしない
 *  - title-suggest が既に未消化 (delivered_at=NULL) なら追加しない
 *
 * 永続化は in-memory only. Concordia 再起動時に再観測 → enqueue は走らない
 * (前回値が消えているので「初回 stat」 扱いになる) — これは保守的な挙動として
 * 受容する.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("repo-change-watcher");

export interface RepoChangeWatcherDeps {
  sessions: SessionsRepo;
  tasks: TasksRepo;
}

export interface RepoChangeWatcherHandle {
  stop: () => void;
  /** テスト用. event を直接食わせる. */
  handle: (ev: ConcordiaEvent) => void;
  /** テスト用. cache を覗く. */
  peekCache: () => Map<string, string>;
}

export function startRepoChangeWatcher(deps: RepoChangeWatcherDeps): RepoChangeWatcherHandle {
  const lastRepoPath = new Map<string, string>();

  function handle(ev: ConcordiaEvent): void {
    if (ev.type !== "stat.collected") return;
    const session = deps.sessions.findSession(ev.session_id);
    if (!session) return;
    const current = session.repo_path;
    const previous = lastRepoPath.get(session.id);
    lastRepoPath.set(session.id, current);
    if (previous === undefined) return; // 初回観測 — 比較対象なし
    if (previous === current) return;
    // 二重 enqueue 抑止: title-suggest が未配信ならパス
    if (deps.tasks.hasUndelivered(session.id, "title-suggest")) return;

    deps.tasks.enqueue({
      session_id: session.id,
      kind: "title-suggest",
      payload: {
        previous_repo_path: previous,
        current_repo_path: current,
        instructions:
          "作業ディレクトリが変わったので、 今やっている作業を 30 文字以内 " +
          "(日本語可、 OSC タイトル向け) で 1 行にまとめて " +
          `POST http://127.0.0.1:17330/v1/sessions/${session.id}/title-suggestion ` +
          "に { \"text\": \"<タイトル文字列>\" } で投稿してほしい. " +
          "Concordia 側が Lictor の /v1/rename に転送してターミナルタイトルを更新する.",
      },
    });
    log.info(
      { session_id: session.id, previous, current },
      "repo_path changed — enqueued title-suggest",
    );
  }

  const unsub = eventBus.subscribe(handle);

  return {
    stop: () => unsub(),
    handle,
    peekCache: () => new Map(lastRepoPath),
  };
}
