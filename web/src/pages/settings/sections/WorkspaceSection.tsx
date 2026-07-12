// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";

import { TextSettingRow, MultiRootSettingRow, putJson } from "./common.js";

// ─── ワークスペース ( workspace root + GitHub Org) ────────────────────────

export function WorkspaceSection() {
  const [workspaceRoots, setWorkspaceRoots] = useState<string[] | null>(null);
  const [githubOrg, setGithubOrg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/state").then((r) => r.json())) as {
        workspace_roots: string[]; github_org: string;
      };
      setWorkspaceRoots(s.workspace_roots ?? []);
      setGithubOrg(s.github_org);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply(path: string, body: unknown, key: string) {
    setBusy(key); setError(null);
    try { await putJson(path, body); await refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">ワークスペース</h2>
        <p className="text-subtle text-xs mt-0.5">
          ローカルクローン親 (リアクションWF / Work 走査の基点) と GitHub Organization。
          保存は schema_meta 永続化。 リアクションWF の cwd 反映は次の bot 再起動後。
        </p>
      </div>
      <MultiRootSettingRow
        current={workspaceRoots} busy={busy === "ws"}
        onApply={(roots) => apply("/v1/admin/workspace-roots", { workspace_roots: roots }, "ws")}
      />
      <TextSettingRow
        label="GitHub Organization"
        hint={<>例 <code>LUDIARS</code>。 PR / repo 操作の owner 解決に使う。</>}
        current={githubOrg} placeholder="LUDIARS" busy={busy === "org"}
        onApply={(v) => apply("/v1/admin/github-org", { github_org: v }, "org")}
      />
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
