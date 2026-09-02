import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

interface SetupResponse {
  service: string;
  url: string;
  provider: string;
  skill_version: string;
  placement?: "user-level" | "per-repo";
  install: {
    skills: Array<{ target_path: string; content: string }>;
    settings_merge: { hooks: Record<string, unknown> };
  };
  instructions: string;
}

export function Setup() {
  const [data, setData] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("claude-code");
  const [placement, setPlacement] = useState<"user-level" | "per-repo">("user-level");
  const [repoPath, setRepoPath] = useState("");
  const projectCodes = useLiveQuery(() => api.projectCodes(), [], "project-codes");

  useEffect(() => {
    const params = new URLSearchParams({ provider });
    if (placement === "per-repo" && repoPath.trim()) {
      params.set("repo_path", repoPath.trim());
    }
    fetch(`/v1/setup?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => setData(j))
      .catch((e) => setError(String(e)));
  }, [provider, placement, repoPath]);

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Setup ガイド</h1>
        <p className="text-subtle text-sm mt-1">
          AI セッションに <code className="text-accent">「Concordia/setup に接続して」</code> と
          指示すると、 セッションが <code>/v1/setup</code> を叩いて skill 本体 + hook
          設定をダウンロードします. 下に同じ内容を表示しているので手動でも適用できます.
        </p>
      </header>

      <section className="bg-surface border border-border rounded p-4 text-sm">
        <h2 className="font-semibold mb-2">1. AI への指示文 (推奨)</h2>
        <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap">
{`Concordia/setup (http://127.0.0.1:11111/v1/setup) に接続して、
  - install.skills[*] の content を target_path に Write
  - install.settings_merge.hooks を ~/.claude/settings.json (もしくは
    project の .claude/settings.local.json) の hooks にマージ
  - skill_version をメモして次回更新検知に使う
  完了したらセッションを 1 回 Restart してください.`}
        </pre>
      </section>

      <section className="bg-surface border border-border rounded p-4 text-sm space-y-3">
        <h2 className="font-semibold">2. Provider / 配置先</h2>
        <div>
          <div className="text-subtle text-xs mb-1">provider</div>
          <div className="flex gap-2 text-xs">
            {["claude-code", "gemini-cli", "codex-cli"].map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={
                  "px-2 py-1 rounded border " +
                  (provider === p
                    ? "bg-accent/20 border-accent text-accent"
                    : "border-border text-subtle hover:text-text")
                }
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-subtle text-xs mb-1">placement</div>
          <div className="flex gap-2 text-xs">
            {(["user-level", "per-repo"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlacement(p)}
                className={
                  "px-2 py-1 rounded border " +
                  (placement === p
                    ? "bg-accent/20 border-accent text-accent"
                    : "border-border text-subtle hover:text-text")
                }
              >
                {p}
              </button>
            ))}
          </div>
          <p className="text-subtle text-[11px] mt-1">
            user-level: <code>~/.claude/skills/concordia/SKILL.md</code> に保存. 全 repo で有効.
            <br />
            per-repo: <code>{"<repo_path>"}/.claude/skills/concordia/SKILL.md</code> に保存. その repo を開いた時のみ有効.
          </p>
        </div>
        {placement === "per-repo" && (
          <div>
            <div className="text-subtle text-xs mb-1">repo_path (絶対パス)</div>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder={"E:/Document/Ars/MyProject  または /home/me/projects/MyProject"}
              className="w-full bg-muted border border-border rounded px-2 py-1 text-xs font-mono"
            />
            {!repoPath.trim() && (
              <p className="text-subtle text-[11px] mt-1">
                空のまま送信すると user-level fallback になります.
              </p>
            )}
          </div>
        )}
      </section>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {data && (
        <>
          <section className="bg-surface border border-border rounded p-4 text-sm">
            <h2 className="font-semibold mb-2">
              3. Skill 本体 (skill_version: <span className="text-accent">{data.skill_version}</span>)
              {data.placement && (
                <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-muted text-subtle">
                  placement: {data.placement}
                </span>
              )}
            </h2>
            <p className="text-subtle text-xs mb-2">
              保存先: <code>{data.install.skills[0]?.target_path}</code>
            </p>
            <pre className="bg-muted p-3 rounded text-[11px] max-h-[40vh] overflow-auto whitespace-pre-wrap">
              {data.install.skills[0]?.content}
            </pre>
          </section>

          <section className="bg-surface border border-border rounded p-4 text-sm">
            <h2 className="font-semibold mb-2">4. Hook 設定 (settings.json にマージ)</h2>
            <pre className="bg-muted p-3 rounded text-[11px] max-h-[40vh] overflow-auto whitespace-pre-wrap">
              {JSON.stringify({ hooks: data.install.settings_merge.hooks }, null, 2)}
            </pre>
          </section>

          <section className="bg-surface border border-border rounded p-4 text-sm">
            <h2 className="font-semibold mb-2">5. 補足指示 (server から AI へ)</h2>
            <pre className="bg-muted p-3 rounded text-[11px] whitespace-pre-wrap">{data.instructions}</pre>
          </section>
        </>
      )}

      <section className="bg-surface border border-border rounded p-4 text-sm">
        <h2 className="font-semibold mb-2">6. Windows PowerShell の文字化け対策</h2>
        <p className="text-subtle text-xs mb-2">
          PS 5.1 は既定 codepage が ANSI なので、 curl で日本語 body を投げると
          DB に文字化けで保存されます. 以下のどれかでセッション開始時に UTF-8 化してください.
        </p>
        <h3 className="text-xs text-subtle mt-3">推奨: codepage 切替</h3>
        <pre className="bg-muted p-3 rounded text-[11px]">
{`chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8`}
        </pre>
        <h3 className="text-xs text-subtle mt-3">代替: ファイル経由 --data-binary</h3>
        <pre className="bg-muted p-3 rounded text-[11px]">
{`$body = '{"channel":"chitchat","session_id":"...","author_label":"...","text":"日本語"}'
[System.IO.File]::WriteAllText("$env:TEMP\\concordia-body.json", $body, [System.Text.UTF8Encoding]::new($false))
curl -s -X POST http://127.0.0.1:11111/v1/chat -H "content-type: application/json" --data-binary "@$env:TEMP\\concordia-body.json"`}
        </pre>
        <h3 className="text-xs text-subtle mt-3">代替: Invoke-RestMethod (PS native)</h3>
        <pre className="bg-muted p-3 rounded text-[11px]">
{`$body = @{ channel="chitchat"; session_id="..."; author_label="..."; text="日本語" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri http://127.0.0.1:11111/v1/chat -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))`}
        </pre>
        <p className="text-subtle text-xs mt-3">
          bash / zsh / git-bash は UTF-8 既定なので通常の <code>curl --data</code> で問題ありません.
        </p>
      </section>

      <section className="bg-surface border border-border rounded p-4 text-sm">
        <h2 className="font-semibold mb-1">7. プロジェクトコード一覧</h2>
        <p className="text-subtle text-xs mb-3">
          チャット / メモ中の略称と対応リポ。Claude → ユーザ方向はフルネームで書く。
          Discord: <code className="text-accent">/projects</code> でも確認できます。
        </p>
        <div className="space-y-3">
          {(projectCodes.data?.categories ?? []).map((cat) => (
            <div key={cat.name}>
              <div className="text-xs font-medium text-subtle mb-1">{cat.name}</div>
              <div className="flex flex-col gap-0.5">
                {cat.entries.map(([code, repo]) => (
                  <div key={code} className="flex gap-1.5 items-baseline text-[11px]">
                    <code className="text-accent font-mono shrink-0 w-10">{code}</code>
                    <span className="text-text">{repo}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {projectCodes.error && (
          <p className="text-danger text-[11px] mt-3">load error: {projectCodes.error.message}</p>
        )}
        <p className="text-subtle text-[11px] mt-3">
          正本: <code>Concordia DB / project_codes</code>（初期登録なし）。
          登録・編集は <a href="/projects" className="text-accent underline">プロジェクト</a> ページから。
        </p>
      </section>
    </div>
  );
}
