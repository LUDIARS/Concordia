/**
 * Title watcher (旧名: repo-change-watcher).
 *
 * セッションのターミナルタイトルを「いま何の作業をしているか」 に追従させるため、
 * 以下の契機で `title-suggest` pending task を 1 件 enqueue する:
 *
 *  1. **初回 stat 観測** — そのセッションを最初に観測した瞬間に 1 回. 起動直後でも
 *     タイトルが「[Cn] (作業内容未設定)」 のままにならないよう即座に依頼する.
 *  2. **repo_path 変化** — 子リポを跨いだ作業切り替えを検知 (PR #33 由来).
 *  3. **新 `prompt` event** — ユーザが新しい指示を出した = 作業内容が切り替わる
 *     可能性が高い. ただし連投で title-suggest が乱発しないよう per-session で
 *     30 秒 debounce する.
 *
 * AI は instructions に従って 30 文字以内のサマリを
 *   POST /v1/sessions/:id/title-suggestion { text }
 * に投稿する. 受信側 (api/sessions.ts) が Lictor の /v1/rename に転送して
 * OSC タイトル + Claude 側 session name を更新する.
 *
 * dedup: title-suggest が未配信なら新規 enqueue しない (hasUndelivered).
 * 永続化は in-memory only — Concordia 再起動時は「初回」 扱いに戻る.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("title-watcher");

/** 新 prompt event で title-suggest を再発火する最小間隔. */
const PROMPT_DEBOUNCE_SEC = 30;

export interface RepoChangeWatcherDeps {
  sessions: SessionsRepo;
  tasks: TasksRepo;
  /** テスト用. 現在時刻 (秒). 既定はシステム時計. */
  now?: () => number;
}

export interface RepoChangeWatcherHandle {
  stop: () => void;
  /** テスト用. event を直接食わせる. */
  handle: (ev: ConcordiaEvent) => void;
  /** テスト用. cache を覗く. */
  peekCache: () => {
    lastRepoPath: Map<string, string>;
    lastPromptFire: Map<string, number>;
  };
}

export function startRepoChangeWatcher(deps: RepoChangeWatcherDeps): RepoChangeWatcherHandle {
  const lastRepoPath = new Map<string, string>();
  const lastPromptFire = new Map<string, number>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  /**
   * title-suggest task を 1 件 enqueue する. dedup (未配信 task が残っていれば
   * skip) は呼び出し側で評価しない — ここで集約する.
   * @returns 実際に enqueue したか
   */
  function enqueueTitleSuggest(
    sessionId: string,
    reason: "initial" | "repo_change" | "prompt",
    extra: Record<string, unknown>,
  ): boolean {
    if (deps.tasks.hasUndelivered(sessionId, "title-suggest")) return false;
    deps.tasks.enqueue({
      session_id: sessionId,
      kind: "title-suggest",
      payload: {
        ...extra,
        reason,
        instructions:
          "現在の作業を 30 文字以内 (日本語可、 OSC タイトル向け) で 1 行に要約して " +
          `POST http://127.0.0.1:17330/v1/sessions/${sessionId}/title-suggestion ` +
          "に { \"text\": \"<タイトル文字列>\" } で投稿してほしい. " +
          "Concordia 側が Lictor の /v1/rename に転送してターミナルタイトルを更新する.",
      },
    });
    return true;
  }

  function handle(ev: ConcordiaEvent): void {
    if (ev.type === "stat.collected") {
      const session = deps.sessions.findSession(ev.session_id);
      if (!session) return;
      const current = session.repo_path;
      const previous = lastRepoPath.get(session.id);
      lastRepoPath.set(session.id, current);

      if (previous === undefined) {
        // 初回観測: ここで一度タイトル要求を投げ、 セッション起動直後も
        // 「いま何してるか」 が反映されるようにする.
        if (enqueueTitleSuggest(session.id, "initial", { current_repo_path: current })) {
          log.info({ session_id: session.id, current }, "initial stat — enqueued title-suggest");
        }
        return;
      }
      if (previous === current) return;
      if (
        enqueueTitleSuggest(session.id, "repo_change", {
          previous_repo_path: previous,
          current_repo_path: current,
        })
      ) {
        log.info(
          { session_id: session.id, previous, current },
          "repo_path changed — enqueued title-suggest",
        );
      }
      return;
    }

    if (ev.type === "session.event" && ev.kind === "prompt") {
      const t = now();
      const last = lastPromptFire.get(ev.session_id) ?? 0;
      if (t - last < PROMPT_DEBOUNCE_SEC) return;
      if (enqueueTitleSuggest(ev.session_id, "prompt", { ts: ev.ts })) {
        lastPromptFire.set(ev.session_id, t);
        log.info({ session_id: ev.session_id }, "new prompt — enqueued title-suggest");
      }
      return;
    }
  }

  const unsub = eventBus.subscribe(handle);

  return {
    stop: () => unsub(),
    handle,
    peekCache: () => ({
      lastRepoPath: new Map(lastRepoPath),
      lastPromptFire: new Map(lastPromptFire),
    }),
  };
}
