// GitHub Issue ワークフロー (Cc ラベル → 修正 → 審査 → GitHub PR) の設定と現況。
// スカラー設定 (ラベル / 信頼実行者 / base / 間隔) は「すべて」へ寄せてあるので、
// ここは専用の作法が要るもの — webhook secret の発行と、 走っている run の現況だけを持つ。
// @implements spec/feature/github-issue-workflow.md — 操作面

import { useEffect, useState } from "react";
import { api, type GithubIssueRun, type GithubIssueWorkflowStatus } from "../../../api.js";

const STATUS_LABEL: Record<string, string> = {
  queued: "受付",
  awaiting_approval: "承認待ち",
  running: "修正中",
  pr_submitted: "審査中",
  review_passed: "審査通過",
  published: "PR 作成済",
  skipped: "修正なし",
  failed: "失敗",
};

/** @implements spec/feature/github-issue-workflow.md — 承認 */
export function GithubIssueWorkflowSection({ onOpenAllSettings }: { onOpenAllSettings?: () => void }) {
  const [status, setStatus] = useState<GithubIssueWorkflowStatus | null>(null);
  const [runs, setRuns] = useState<GithubIssueRun[]>([]);
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [next, runList] = await Promise.all([
        api.githubIssueWorkflowStatus(),
        api.githubIssueRuns(20),
      ]);
      setStatus(next);
      setRuns(runList.runs);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function issueSecret() {
    setBusy(true); setError(null);
    try {
      const result = await api.githubIssueWorkflowSetSecret();
      // 生成した値はこの一度しか出さない (以後は保存済みかどうかだけ)。
      setIssued(result.secret);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function approve(id: string) {
    setBusy(true); setError(null);
    try {
      await api.githubIssueRunApprove(id);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function reject(id: string) {
    // 理由は必須。 何も言わずに閉じると Issue を出した人に何も返らない。
    const reason = window.prompt("却下の理由 (そのまま Issue へのコメントになります)");
    if (reason === null || reason.trim() === "") return;
    setBusy(true); setError(null);
    try {
      await api.githubIssueRunReject(id, reason.trim());
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function retry(id: string) {
    setBusy(true); setError(null);
    try {
      await api.githubIssueRunRetry(id);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">GitHub Issue ワークフロー</h2>
        <p className="text-subtle text-xs mt-0.5">
          対象プロジェクトの Issue に <code>{status?.label ?? "Cc"}</code> ラベルが付くと、
          修正を委託し Revisor の審査を通してから GitHub PR を作り、Issue にリンクを返します。
          起票者もラベルを付けた人も信頼実行者でない場合は着手せず、ここに承認ボタンが出ます。
          対象にするかは <strong>プロジェクトコード</strong>画面の「Issue WF」で切り替えます。
        </p>
      </div>

      {error && <p className="text-xs text-warn">{error}</p>}

      {status && (
        <dl className="text-xs grid grid-cols-[10rem_1fr] gap-y-1">
          <dt className="text-subtle">webhook secret</dt>
          <dd>
            {status.webhook_secret_set ? "設定済み" : <span className="text-warn">未設定 (webhook は全拒否)</span>}
            <button type="button" disabled={busy} onClick={() => void issueSecret()}
              className="ml-2 text-accent disabled:opacity-40">
              {status.webhook_secret_set ? "再発行" : "発行"}
            </button>
            {status.webhook_secret_error && (
              <span className="ml-2 text-warn">{status.webhook_secret_error}</span>
            )}
          </dd>
          <dt className="text-subtle">信頼実行者</dt>
          <dd>
            {status.trusted_actors.length === 0
              ? <span className="text-warn">未設定 — 全件が承認待ちになります</span>
              : status.trusted_actors.join(", ")}
          </dd>
          <dt className="text-subtle">対象プロジェクト</dt>
          <dd>
            {status.projects.length === 0
              ? <span className="text-subtle">なし</span>
              : status.projects.map((project) => project.code).join(", ")}
          </dd>
          <dt className="text-subtle">PR の base / 委託テンプレ</dt>
          <dd><code>{status.base_branch}</code> / <code>{status.fix_call_name}</code></dd>
        </dl>
      )}

      {issued && (
        <p className="text-xs border border-border rounded p-2 break-all">
          発行した secret (この画面でしか表示されません。GitHub の webhook 設定へ貼ってください):
          <code className="ml-1">{issued}</code>
        </p>
      )}

      <div>
        <h3 className="text-xs font-semibold mb-1">最近の run</h3>
        {runs.length === 0
          ? <p className="text-subtle text-xs">まだありません。</p>
          : (
            <table className="w-full text-xs">
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border/50">
                    <td className="py-1 pr-2 whitespace-nowrap">
                      <a href={run.issue_url} target="_blank" rel="noreferrer" className="text-accent">
                        {run.repo_origin}#{run.issue_number}
                      </a>
                    </td>
                    <td className="py-1 pr-2">{STATUS_LABEL[run.status] ?? run.status}</td>
                    <td className="py-1 pr-2 text-subtle break-all">
                      {run.github_pr_url
                        ? <a href={run.github_pr_url} target="_blank" rel="noreferrer" className="text-accent">PR</a>
                        : run.status === "awaiting_approval"
                          ? `起票 @${run.issue_author ?? "?"} / ラベル @${run.actor ?? "?"}`
                          : run.detail ?? ""}
                    </td>
                    <td className="py-1 text-right whitespace-nowrap">
                      {run.status === "awaiting_approval" ? (
                        <>
                          <button type="button" disabled={busy} onClick={() => void approve(run.id)}
                            className="text-accent disabled:opacity-40 mr-2">承認して実行</button>
                          <button type="button" disabled={busy} onClick={() => void reject(run.id)}
                            className="text-subtle hover:text-text disabled:opacity-40">却下</button>
                        </>
                      ) : (run.status === "failed" || run.status === "skipped" || run.status === "published") && (
                        <button type="button" disabled={busy} onClick={() => void retry(run.id)}
                          className="text-accent disabled:opacity-40">再実行</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {onOpenAllSettings && (
        <p className="text-[11px] text-subtle">
          ラベル名・信頼実行者・ポーリング間隔は{" "}
          <button type="button" className="text-accent underline" onClick={onOpenAllSettings}>設定 &gt; すべて</button>
          {" "}の <code>github.*</code> で変更します。
        </p>
      )}
    </section>
  );
}
