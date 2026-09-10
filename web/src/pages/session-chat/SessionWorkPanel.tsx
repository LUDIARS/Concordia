import { Link } from "react-router-dom";
import { api, type SessionRow } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { isSessionPr, isSessionTask } from "./related-work.js";

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
export function SessionWorkPanel({ session, onClose }: { session: SessionRow; onClose: () => void }) {
  const tasks = useLiveQuery(() => api.sessionTasks(session.id), ["hello", "session.event"], session.id);
  const workflow = useLiveQuery(() => api.taskflowOverview(), ["hello", "task.enqueued", "session.task_changed", "pr.changed"], session.id);
  const testing = useLiveQuery(() => api.testingClaims(), ["hello", "session.event", "operational.claim.opened", "operational.claim.released"], session.id);
  const prs = useLiveQuery(() => api.prsRevisor(), ["hello", "pr.changed"], session.id);
  const linkedTasks = workflow.data?.tasks.filter((task) => isSessionTask(task, session.id)) ?? [];
  const claims = testing.data?.claims.filter((claim) => claim.session_id === session.id) ?? [];
  const linkedPrs = prs.data?.pull_requests.filter((pr) => isSessionPr(pr, session)) ?? [];
  /** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
  const refresh = (): void => { tasks.refetch(); workflow.refetch(); testing.refetch(); prs.refetch(); };

  return (
    <aside id="session-work-panel" aria-label="関連タスク・テスト・PR" className="absolute inset-y-0 right-0 z-20 w-full max-w-sm overflow-y-auto overscroll-contain border-l border-border bg-surface p-4 shadow-xl">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">タスク・テスト/PR</h2>
        <button type="button" onClick={refresh} className="text-sm text-accent">更新</button>
        <button type="button" onClick={onClose} aria-label="関連作業を閉じる">×</button>
      </div>
      <section className="mt-4 space-y-2 text-sm">
        <h3 className="font-semibold">タスク</h3>
        {session.current_task && <p className="break-words text-subtle">{session.current_task}</p>}
        <LoadState error={tasks.error} loading={!tasks.data} />
        {tasks.data?.items.map((task) => <div key={task.id} className="rounded border border-border p-2"><span className="text-xs text-subtle">{task.status}</span><p className="break-words">{task.task_text}</p></div>)}
        <LoadState error={workflow.error} loading={!workflow.data} />
        {linkedTasks.map((task) => <div key={task.path} className="rounded border border-border p-2"><span className="text-xs text-subtle">{task.status}</span><p className="break-words">{task.title}</p>{task.pr && <p>PR #{task.pr.number} · {task.pr.state} · CI: {task.ci_status}</p>}</div>)}
        {tasks.data?.items.length === 0 && workflow.data && linkedTasks.length === 0 && <p className="text-subtle">関連タスクはありません</p>}
      </section>
      <section className="mt-4 space-y-2 text-sm">
        <h3 className="font-semibold">実行中のテスト宣言</h3>
        <LoadState error={testing.error} loading={!testing.data} />
        {claims.map((claim) => <div key={claim.id} className="rounded border border-border p-2"><p>{claim.service}</p><p className="break-words text-subtle">{claim.note || "テスト宣言中"}</p></div>)}
        {testing.data && claims.length === 0 && <p className="text-subtle">実行中の宣言はありません</p>}
      </section>
      <section className="mt-4 space-y-2 text-sm">
        <h3 className="font-semibold">PR・審査</h3>
        <LoadState error={prs.error} loading={!prs.data} />
        {prs.data?.error && <p role="alert" className="text-danger">{prs.data.error}</p>}
        {prs.data && !prs.data.configured && <p className="text-subtle">Revisor は未設定です</p>}
        {linkedPrs.map((pr) => <div key={pr.id} className="rounded border border-border p-2"><p className="break-words">#{pr.number} {pr.title}</p><p className="text-xs text-subtle">{pr.status} · 審査: {pr.checkStatus}</p><p className="break-words text-xs text-subtle">{pr.headRef}</p></div>)}
        {prs.data?.configured && !prs.data.error && linkedPrs.length === 0 && <p className="text-subtle">関連 PR はありません</p>}
        <Link to="/prs" className="inline-block text-accent">PR 一覧を開く →</Link>
      </section>
    </aside>
  );
}

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
function LoadState({ error, loading }: { error: Error | null; loading: boolean }) {
  if (error) return <p role="alert" className="text-danger">取得失敗: {error.message}</p>;
  return loading ? <p className="text-subtle">読み込み中...</p> : null;
}
