// GitHub Issue ワークフロー (Cc ラベル → 対応 → 審査 → GitHub PR) の設定と現況。
// ラベル名 / base / 間隔は「すべて」へ寄せたままだが、 **信頼実行者はここで編集する** —
// 承認待ちの run を見ながら「この人は今後そのまま通す」と決める操作なので、 run 一覧と
// 名簿の隣にあるべきもの (2026-09-06 neco 指示)。 保存先は設定レジストリのままで、
// 書き込みも既存の PUT /v1/admin/settings を通す (検証を二重に持たない)。
// @implements spec/feature/github-issue-workflow.md — 信頼実行者

import { useEffect, useState } from "react";
import { api, type GithubIssueActor, type GithubIssueRun, type GithubIssueWorkflowStatus } from "../../../api.js";
import { GithubWebhookSecrets } from "./GithubWebhookSecrets.js";

const TRUSTED_ACTORS_KEY = "github.trusted_actors";

const ACTOR_KIND_LABEL: Record<string, string> = {
  labeler: "ラベル付与",
  author: "起票",
};

/**
 * 設定レジストリの string-list と同じく、空行を除いて大小文字を無視して重複排除する。
 * GitHub Apps の login は `dependabot[bot]` のような表記もあるため、ユーザー名用の
 * 狭い正規表現をここで重ねない。
 * @implements spec/feature/github-issue-workflow.md — 信頼実行者
 */
function parseActorDraft(draft: string): string[] {
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const line of draft.split(/\r?\n/)) {
    const login = line.trim();
    if (login === "") continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  return logins;
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 信頼実行者の編集下書き (1 行 1 件)。 保存するまでサーバの値は変えない。
  const [actorDraft, setActorDraft] = useState<string | null>(null);
  const [actorNote, setActorNote] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [next, runList] = await Promise.all([
        api.githubIssueWorkflowStatus(),
        api.githubIssueRuns(20),
      ]);
      setStatus(next);
      setRuns(runList.runs);
      // 編集中は上書きしない — 保存前の入力を refresh で消さない。
      setActorDraft((draft) => (draft === null ? next.trusted_actors.join("\n") : draft));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  /**
   * 信頼実行者リストの保存。 書き込み先は設定レジストリ 1 本で、 この画面は
   * 同じキーを別の入口から編集しているだけ (「すべて」と正本を分けない)。
   * @implements spec/feature/github-issue-workflow.md — 信頼実行者
   */
  async function saveTrustedActors(logins: string[], note: string) {
    setBusy(true); setError(null); setActorNote(null);
    try {
      const outcome = await api.updateSettings({ [TRUSTED_ACTORS_KEY]: logins });
      if (!outcome.ok) {
        setError(outcome.rejected.map((item) => `${item.key}: ${item.detail ?? item.code}`).join(" / "));
        return;
      }
      setActorDraft(logins.join("\n"));
      setActorNote(note);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  /** @implements spec/feature/github-issue-workflow.md — 信頼実行者 */
  function saveDraft() {
    const logins = parseActorDraft(actorDraft ?? "");
    void saveTrustedActors(logins, logins.length === 0
      ? "信頼実行者を空にしました (以後は全件が承認待ちになります)"
      : `信頼実行者を ${logins.length} 件で保存しました`);
  }

  /**
   * 名簿から後追いで許可する / 取り消す。テキスト欄の未保存編集も保持したまま
   * 対象 login だけを足し引きし、別の編集を黙って失わない。
   * @implements spec/feature/github-issue-workflow.md — 信頼実行者
   */
  function toggleTrust(actor: GithubIssueActor) {
    const current = parseActorDraft(actorDraft ?? (status?.trusted_actors ?? []).join("\n"));
    const withoutActor = current.filter((login) => login.toLowerCase() !== actor.login.toLowerCase());
    const next = actor.trusted
      ? withoutActor
      : [...withoutActor, actor.display_login];
    void saveTrustedActors(
      next,
      actor.trusted ? `@${actor.display_login} の許可を外しました` : `@${actor.display_login} を信頼実行者に追加しました`,
    );
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
        <>
          <GithubWebhookSecrets
            status={status}
            disabled={busy}
            onChanged={refresh}
            onError={setError}
          />
          <dl className="text-xs grid grid-cols-[10rem_1fr] gap-y-1">
            <dt className="text-subtle">信頼実行者</dt>
            <dd>
              {status.trusted_actors.length === 0
                ? <span className="text-warn">未設定 — 全件が承認待ちになります</span>
                : status.trusted_actors.join(", ")}
            </dd>
            <dt className="text-subtle">PR の base / 委託テンプレ</dt>
            <dd><code>{status.base_branch}</code> / <code>{status.fix_call_name}</code></dd>
          </dl>
        </>
      )}

      <div className="space-y-1">
        <h3 className="text-xs font-semibold">信頼実行者 (GitHub login)</h3>
        <p className="text-subtle text-[11px]">
          ここに載っている人が起票、またはラベルを付けた Issue は確認なしで着手します。
          <strong>空 = 全件が承認待ち</strong>であって「全員許可」ではありません。1 行に 1 件。
        </p>
        <textarea
          className="w-full text-xs font-mono border border-border rounded p-2 bg-transparent"
          rows={Math.min(8, Math.max(3, (actorDraft ?? "").split("\n").length + 1))}
          value={actorDraft ?? ""}
          onChange={(e) => setActorDraft(e.target.value)}
          placeholder="1 行に 1 件 (例: nyangame)"
          spellCheck={false}
        />
        <div className="flex items-center gap-3">
          <button type="button" disabled={busy || actorDraft === null} onClick={saveDraft}
            className="text-accent text-xs disabled:opacity-40">保存</button>
          <button type="button" disabled={busy || !status} onClick={() => setActorDraft((status?.trusted_actors ?? []).join("\n"))}
            className="text-subtle hover:text-text text-xs disabled:opacity-40">元に戻す</button>
          {actorNote && <span className="text-[11px] text-subtle">{actorNote}</span>}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold mb-1">ラベルを押した人 / 起票した人</h3>
        {(status?.actors.length ?? 0) === 0
          ? <p className="text-subtle text-xs">まだ観測していません。対象リポジトリの Issue にラベルが付くと記録します。</p>
          : (
            <table className="w-full text-xs">
              <tbody>
                {(status?.actors ?? []).map((actor) => (
                  <tr key={actor.login} className="border-b border-border/50">
                    <td className="py-1 pr-2 whitespace-nowrap">@{actor.display_login}</td>
                    <td className="py-1 pr-2 text-subtle whitespace-nowrap">
                      {ACTOR_KIND_LABEL[actor.last_kind] ?? actor.last_kind} / {actor.seen_count} 件
                    </td>
                    <td className="py-1 pr-2 text-subtle break-all">
                      {actor.last_repo}#{actor.last_issue_number}
                    </td>
                    <td className="py-1 pr-2 text-subtle whitespace-nowrap">
                      {new Date(actor.last_seen_at).toLocaleString()}
                    </td>
                    <td className="py-1 text-right whitespace-nowrap">
                      {actor.trusted ? (
                        <>
                          <span className="text-subtle mr-2">許可済み</span>
                          <button type="button" disabled={busy} onClick={() => toggleTrust(actor)}
                            className="text-subtle hover:text-text disabled:opacity-40">解除</button>
                        </>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => toggleTrust(actor)}
                          className="text-accent disabled:opacity-40">信頼実行者に追加</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
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
          ラベル名・PR の base・ポーリング間隔は{" "}
          <button type="button" className="text-accent underline" onClick={onOpenAllSettings}>設定 &gt; すべて</button>
          {" "}の <code>github.*</code> で変更します (信頼実行者はこの画面が同じキーを書きます)。
        </p>
      )}
    </section>
  );
}
