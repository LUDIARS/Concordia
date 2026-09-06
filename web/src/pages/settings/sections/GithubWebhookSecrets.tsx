// GitHub Issue ワークフローの webhook secret を「共通 1 本」と「プロジェクト別」で編集する面。
// 発行 (Cc が生成して 1 度だけ見せる) に加えて、**GitHub 側に既にある値の貼り付け**と
// **削除**を持つ — webhook を先に作ってあるリポでは正本が GitHub 側にしか無く、発行しか
// 無いと GitHub 側を貼り直すまで受信が止まる (2026-09-06 neco 指示)。
// 保存済みの値は読み出さない (API も返さない) ので、この画面は「入っているか」だけを映す。
// @implements spec/feature/github-issue-workflow.md — webhook secret

import { useState } from "react";
import { api, type GithubIssueWorkflowStatus } from "../../../api.js";

/** サーバ側 (SecretSchema) と同じ長さの範囲。 往復する前にここで弾いて理由を出す。 */
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 200;

/** 共通 secret を指す編集キー。 リポジトリ別は repo_origin をそのまま鍵にする。 */
const COMMON = "";

export interface GithubWebhookSecretsProps {
  status: GithubIssueWorkflowStatus;
  /** 親の操作中は触らせない。 */
  disabled: boolean;
  /** 書き込み後に現況を取り直す。 */
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}

export function GithubWebhookSecrets({ status, disabled, onChanged, onError }: GithubWebhookSecretsProps) {
  const [busy, setBusy] = useState(false);
  // 貼り付け中の対象 (null = どこも開いていない)。 開いている間だけ入力欄を出す。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 発行した値。 この画面でしか出さないので、次の操作まで残す。
  const [issued, setIssued] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const locked = disabled || busy;

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true); onError(null); setNote(null);
    try {
      await action();
      await onChanged();
      setNote(message);
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  function issue(repo?: string) {
    void run(async () => {
      const result = await api.githubIssueWorkflowSetSecret(repo ? { repo } : {});
      setIssued(result.secret);
      // 発行した値で上書きされたので、 貼り付け途中の入力は残さない。
      setEditing(null);
      setDraft("");
    }, repo ? `${repo} の専用 secret を発行しました` : "共通 secret を発行しました");
  }

  function save(target: string) {
    const secret = draft.trim();
    if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
      // 範囲外はサーバも 400 で落とすが、 そこからは理由が読めないのでここで返す。
      onError(`secret は ${MIN_SECRET_LENGTH}〜${MAX_SECRET_LENGTH} 文字です (GitHub 側に設定した値をそのまま貼ってください)`);
      return;
    }
    void run(async () => {
      await api.githubIssueWorkflowSetSecret(target === COMMON ? { secret } : { secret, repo: target });
      // 貼り付けた値は保存後に画面へ残さない。
      setDraft("");
      setEditing(null);
      setIssued(null);
    }, target === COMMON ? "共通 secret を保存しました" : `${target} の専用 secret を保存しました`);
  }

  function clear(target: string) {
    const label = target === COMMON
      ? "共通 secret を削除します。リポジトリ別 secret が無いリポの webhook は 503 で全拒否になります。"
      : `${target} の専用 secret を削除します。以後このリポは共通 secret で検証します。`;
    if (!window.confirm(label)) return;
    void run(async () => {
      await api.githubIssueWorkflowClearSecret(target === COMMON ? {} : { repo: target });
      setIssued(null);
      // 消した先の入力欄を開いたままにしない。
      if (editing === target) setEditing(null);
      setDraft("");
    }, target === COMMON ? "共通 secret を削除しました" : `${target} の専用 secret を削除しました`);
  }

  function openEditor(target: string) {
    setEditing(target);
    setDraft("");
    onError(null);
    setNote(null);
    // これから別の値を貼るので、 発行した値を画面へ残さない。
    setIssued(null);
  }

  function editor(target: string) {
    if (editing !== target) return null;
    return (
      <span className="inline-flex items-center gap-1 ml-2">
        <input
          type="password"
          className="text-xs font-mono border border-border rounded px-1 py-0.5 bg-transparent w-64"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="GitHub 側の webhook secret を貼る"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" disabled={locked} onClick={() => save(target)}
          className="text-accent disabled:opacity-40">保存</button>
        <button type="button" disabled={locked} onClick={() => { setEditing(null); setDraft(""); }}
          className="text-subtle hover:text-text disabled:opacity-40">取消</button>
      </span>
    );
  }

  function actions(target: string, present: boolean) {
    return (
      <>
        <button type="button" disabled={locked} onClick={() => issue(target === COMMON ? undefined : target)}
          className="text-accent disabled:opacity-40">
          {present ? "再発行" : "発行"}
        </button>
        <button type="button" disabled={locked} onClick={() => openEditor(target)}
          className="text-accent disabled:opacity-40">貼り付け</button>
        {present && (
          <button type="button" disabled={locked} onClick={() => clear(target)}
            className="text-subtle hover:text-text disabled:opacity-40">削除</button>
        )}
      </>
    );
  }

  return (
    <div className="space-y-1">
      <dl className="text-xs grid grid-cols-[10rem_1fr] gap-y-1">
        <dt className="text-subtle">共通 webhook secret</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span>
            {status.webhook_secret_set
              ? "設定済み (リポ専用が無いときのみ使用)"
              : <span className="text-warn">未設定</span>}
          </span>
          {actions(COMMON, status.webhook_secret_set)}
          {status.webhook_secret_error && <span className="text-warn">{status.webhook_secret_error}</span>}
          {editor(COMMON)}
        </dd>
        <dt className="text-subtle">対象プロジェクト</dt>
        <dd className="space-y-0.5">
          {status.projects.length === 0
            ? <span className="text-subtle">なし</span>
            : status.projects.map((project) => (
              <div key={project.code} className="flex flex-wrap items-center gap-2">
                <span>{project.code}</span>
                <span className="text-subtle break-all">{project.repo_origin ?? "(remote 未登録)"}</span>
                <span className={project.webhook_secret_set ? "text-subtle" : "text-warn"}>
                  {project.webhook_secret_set ? "専用 secret 設定済み" : "専用 secret 未設定 (共通を使用)"}
                </span>
                {/* remote が無いリポは保存キーを作れないので操作そのものを出さない。 */}
                {project.repo_origin && actions(project.repo_origin, project.webhook_secret_set)}
                {project.repo_origin && editor(project.repo_origin)}
              </div>
            ))}
        </dd>
      </dl>

      {note && <p className="text-[11px] text-subtle">{note}</p>}

      {issued && (
        <p className="text-xs border border-border rounded p-2 break-all">
          発行した secret (この画面でしか表示されません。GitHub の webhook 設定へ貼ってください):
          <code className="ml-1">{issued}</code>
        </p>
      )}
    </div>
  );
}
