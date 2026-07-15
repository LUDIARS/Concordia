import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type { SessionEvent, SessionRow } from "../api.js";
import { useLiveQuery, useWsEvent } from "../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../project-codes.js";
import { ActiveReposPanel, InjectForm } from "./session-detail/ConversationPanels.js";
import { LatestStatPanel, ActionButtonRow, EventLogToggle } from "./session-detail/SessionControls.js";
import { PermissionModal, AskUserQuestionModal } from "./session-detail/SessionModals.js";
import { SessionActivityPanel } from "./session-detail/SessionActivityPanel.js";


/**
 * SessionDetail — モバイル / デスクトップ共通の縦スタック.
 *
 *   1. ヘッダ (ロール / セッション情報)
 *   2. 作業リポジトリのコード一覧
 *   3. 直近の会話 5 件 (3 行で省略)
 *   4. テキスト入力 (textarea; Enter=送信, Shift+Enter=改行)
 *   5. 直近 stat
 *   6. 停止 / stat / rename ボタン
 *   7. event log (toggle)
 *   8. transcript log (toggle、 raw 全フレーム)
 */
export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, refetch } = useLiveQuery(
    () => api.session(id!),
    [],
    id,
  );

  useWsEvent(["session.event", "session.ended", "session.lost", "report.generated"], (ev) => {
    if ("session_id" in ev && ev.session_id === id) refetch();
  });

  if (!id) return <div>session id missing</div>;
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  const s = data.session;
  const role = (s.metadata as any)?.role_label ?? "雑用係";
  const lictorPid =
    typeof (s.metadata as any)?.lictor_pid === "number" ? ((s.metadata as any).lictor_pid as number) : null;
  const isActive = s.status === "active";

  return (
    <div className="space-y-4 max-w-6xl">
      <Link to="/" className="text-sm text-subtle hover:text-accent">
        ← back
      </Link>

      {/* 1. ヘッダ */}
      <header className="bg-surface border border-border rounded p-4">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className={`px-1.5 py-0.5 rounded ${statusBadge(s.status)}`}>{s.status}</span>
          <span className="text-subtle">{s.provider}</span>
          <span className="ml-auto text-accent">{role}</span>
        </div>
        <h1 className="mt-2 font-mono text-base break-all">{s.repo_path}</h1>
        <div className="text-xs text-subtle flex flex-wrap gap-x-3 gap-y-1">
          <span>id={s.id}</span>
          <span>branch={s.branch ?? "-"}</span>
          <span>host={s.host}</span>
          <span>started={fmtTs(s.started_at)}</span>
          <span>last_seen={fmtTs(s.last_seen_at)}</span>
          {s.ended_at && <span>ended={fmtTs(s.ended_at)}</span>}
        </div>
        {s.status === "ended" && (
          <Link
            to={`/reports/${encodeURIComponent(s.id)}`}
            className="inline-block mt-2 text-accent text-sm"
          >
            view report →
          </Link>
        )}
      </header>

      {/* 2. 作業リポジトリのコード一覧 */}
      <ActiveReposPanel session={s} />

      {/* Discord relay の要約経路とは独立した、保存済み transcript の全文表示。 */}
      <SessionActivityPanel sessionId={s.id} />

      {/* 5. 直近 stat */}
      <LatestStatPanel sessionId={s.id} />

      {/* 6. 停止 / stat / rename ボタン (active 時のみ) */}
      {isActive && <ActionButtonRow sessionId={s.id} canStop={lictorPid !== null} onStopped={refetch} />}

      {/* 7. event log (toggle) */}
      <EventLogToggle events={data.events} />

      {/* 指示入力は会話を読みながら使えるよう画面下部に固定する。 */}
      {isActive && (
        <div className="sticky bottom-0 z-10 bg-bg/95 pt-2 pb-1 backdrop-blur">
          <InjectForm sessionId={s.id} />
        </div>
      )}

      {/* permission modal — active 時のみ */}
      {isActive && <PermissionModal sessionId={s.id} />}
      {isActive && <AskUserQuestionModal sessionId={s.id} events={data.events} />}
    </div>
  );
}
