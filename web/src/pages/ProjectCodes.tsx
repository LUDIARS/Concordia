import { useEffect, useState } from "react";
import { api, type ProjectCodeAdminEntry, type ProjectCodesAdminResult } from "../api.js";

// @implements spec/feature/project-code-registry.md — 管理 UI

// プロジェクトコード registry の管理ページ。
//
// 正本の対応関係:
//  - 略称/名前/パス/GitHub URL … Concordia DB `project_codes`
//  - Rv モード … Revisor の repository workflow (revisor = GitHub App + Release 管理 /
//    github = 通常 push)。 変更は Revisor 登録の upsert 経由 (未登録リポは変更不可)
//  - 関係チーム … `team_repos` (repo_origin 紐付け、複数可)
//  - 関係会社 … `subsidiary_projects` (project 名紐付け、複数可。 未選択 = 本社のみ)

const RV_MODE_LABEL: Record<string, string> = {
  revisor: "Revisor (App+Release)",
  github: "GitHub (通常push)",
};

/** @implements spec/feature/project-code-registry.md — 管理 UI registration */
function RegisterForm({ onRegistered, onError }: {
  onRegistered: () => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);

  /** @implements spec/feature/project-code-registry.md — 管理 UI registration */
  async function submit() {
    if (!code.trim() || !repoPath.trim()) return;
    setBusy(true);
    try {
      await api.projectCodeRegister({ code: code.trim(), repo_path: repoPath.trim(), added_by: "webui" });
      setCode("");
      setRepoPath("");
      onRegistered();
    } catch (e) {
      onError(`登録に失敗しました: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-subtle">
        略称
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Cc"
          className="foundation-form text-sm block w-24 font-mono"
        />
      </label>
      <label className="text-xs text-subtle flex-1 min-w-64">
        リポジトリパス (workspace 内の git repo)
        <input
          type="text"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="E:/Document/Ars/MyProject"
          className="foundation-form text-sm block w-full font-mono"
        />
      </label>
      <button
        type="button"
        disabled={busy || !code.trim() || !repoPath.trim()}
        onClick={() => void submit()}
        className="bg-accent/20 border border-accent text-accent rounded px-3 py-1 text-sm disabled:opacity-40"
      >
        登録
      </button>
    </div>
  );
}

/** @implements spec/feature/project-code-registry.md — 管理 UI editing and assignments */
function EditableRow({ entry, data, busy, onAction, onError }: {
  entry: ProjectCodeAdminEntry;
  data: ProjectCodesAdminResult;
  busy: boolean;
  onAction: (key: string, action: () => Promise<unknown>) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState({
    code: entry.code,
    project: entry.project,
    repo_path: entry.repo_path,
    repo_origin: entry.repo_origin ?? "",
  });
  // 他セッションの変更で行が入れ替わったら編集前の値も追随させる。
  /** @implements spec/feature/project-code-registry.md — 管理 UI refresh after external edits */
  useEffect(() => {
    setDraft({
      code: entry.code,
      project: entry.project,
      repo_path: entry.repo_path,
      repo_origin: entry.repo_origin ?? "",
    });
    setConfirmingDelete(false);
  }, [entry.code, entry.project, entry.repo_path, entry.repo_origin]);

  /** @implements spec/feature/project-code-registry.md — 管理 UI editing */
  async function save() {
    const body: Parameters<typeof api.projectCodeUpdate>[1] = {};
    if (draft.code !== entry.code) body.code = draft.code.trim();
    if (draft.project !== entry.project) body.project = draft.project.trim();
    if (draft.repo_path !== entry.repo_path) body.repo_path = draft.repo_path.trim();
    if ((draft.repo_origin || null) !== entry.repo_origin) body.repo_origin = draft.repo_origin.trim() || null;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await onAction(entry.code, () => api.projectCodeUpdate(entry.code, body));
    if (ok) setEditing(false);
  }

  const inputClass = "foundation-form text-xs font-mono w-full";
  if (editing) {
    return (
      <tr className="border-b border-border/50 bg-muted/40">
        <td className="py-1.5 pr-2">
          <input className={`${inputClass} w-16`} value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        </td>
        <td className="py-1.5 pr-2">
          <input className={inputClass} value={draft.project}
            onChange={(e) => setDraft({ ...draft, project: e.target.value })} />
        </td>
        <td className="py-1.5 pr-2">
          <input className={inputClass} value={draft.repo_path}
            onChange={(e) => setDraft({ ...draft, repo_path: e.target.value })} />
        </td>
        <td className="py-1.5 pr-2">
          <input className={inputClass} value={draft.repo_origin} placeholder="https://github.com/ORG/REPO.git"
            onChange={(e) => setDraft({ ...draft, repo_origin: e.target.value })} />
        </td>
        <td className="py-1.5 pr-2 text-[11px] text-subtle" colSpan={2}>
          パス変更時は git を再検査し、名前/URL は未入力なら実リポから取り直します。
        </td>
        <td className="py-1.5 text-right whitespace-nowrap">
          <button type="button" disabled={busy} onClick={() => void save()}
            className="text-accent text-xs mr-2 disabled:opacity-40">保存</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)}
            className="text-subtle hover:text-text text-xs disabled:opacity-40">取消</button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border/50">
      <td className="py-1.5 pr-2"><code className="text-accent font-mono">{entry.code}</code></td>
      <td className="py-1.5 pr-2 text-sm">{entry.project}</td>
      <td className="py-1.5 pr-2 text-[11px] font-mono text-subtle break-all">{entry.repo_path}</td>
      <td className="py-1.5 pr-2 text-[11px] font-mono text-subtle break-all">
        {entry.repo_origin ?? <span className="text-subtle/60">(なし)</span>}
      </td>
      <td className="py-1.5 pr-2">
        {entry.revisor?.registered ? (
          <select
            value={entry.revisor.workflow ?? "revisor"}
            disabled={busy || !data.revisor_available}
            onChange={(e) => {
              void onAction(entry.code, () =>
                api.projectCodeSetRevisorWorkflow(entry.code, e.target.value as "revisor" | "github"));
            }}
            className="foundation-form text-xs"
          >
            {Object.entries(RV_MODE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        ) : (
          <span
            className="text-[11px] text-subtle"
            title={data.revisor_available
              ? "Revisor にリポジトリ登録がありません (登録テスト付きで Revisor 側から登録してください)"
              : "Revisor に接続できません"}
          >
            {data.revisor_available ? "Rv未登録" : "Rv不明"}
          </span>
        )}
      </td>
      <td className="py-1.5 pr-2">
        <select
          multiple
          value={entry.teams.map((team) => team.id)}
          disabled={busy || !entry.repo_origin}
          title={entry.repo_origin ? undefined : "チーム紐付けには GitHub URL が必要です"}
          onChange={(e) => {
            const teamIds = [...e.target.selectedOptions].map((option) => option.value);
            void onAction(entry.code, () => api.projectCodeAssignTeams(entry.code, teamIds));
          }}
          className="foundation-form text-xs min-w-28"
        >
          {data.teams.map((team) => (
            <option key={team.id} value={team.id}>{team.name}</option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2">
        <select
          multiple
          value={entry.subsidiaries.map((subsidiary) => subsidiary.id)}
          disabled={busy}
          onChange={(e) => {
            const subsidiaryIds = [...e.target.selectedOptions].map((option) => option.value);
            void onAction(entry.code, () => api.projectCodeAssignSubsidiaries(entry.code, subsidiaryIds));
          }}
          className="foundation-form text-xs min-w-28"
        >
          {data.subsidiaries.map((subsidiary) => (
            <option key={subsidiary.id} value={subsidiary.id}>{subsidiary.name}</option>
          ))}
        </select>
      </td>
      <td className="py-1.5 text-right whitespace-nowrap">
        <button type="button" disabled={busy} onClick={() => { setEditing(true); onError(""); }}
          className="text-subtle hover:text-text text-xs mr-2 disabled:opacity-40">編集</button>
        {confirmingDelete ? (
          <>
            <button type="button" disabled={busy}
              onClick={() => { void onAction(entry.code, () => api.projectCodeDelete(entry.code)); }}
              className="text-danger text-xs mr-1 disabled:opacity-40">本当に削除</button>
            <button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}
              className="text-subtle hover:text-text text-xs disabled:opacity-40">やめる</button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => setConfirmingDelete(true)}
            className="text-subtle hover:text-danger text-xs disabled:opacity-40">削除</button>
        )}
      </td>
    </tr>
  );
}

/** @implements spec/feature/project-code-registry.md — 管理 UI */
export function ProjectCodes() {
  const [data, setData] = useState<ProjectCodesAdminResult | null>(null);
  const [error, setError] = useState<string>("");
  const [busyCode, setBusyCode] = useState<string | null>(null);

  /** @implements spec/feature/project-code-registry.md — 管理 UI listing */
  async function refresh() {
    try {
      setData(await api.projectCodesAdmin());
    } catch (e) {
      setError(`load error: ${String(e)}`);
    }
  }

  /** @implements spec/feature/project-code-registry.md — 管理 UI initial load */
  useEffect(() => {
    void refresh();
  }, []);

  /** @implements spec/feature/project-code-registry.md — 管理 UI mutation lifecycle */
  async function run(code: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusyCode(code);
    setError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(`更新に失敗しました: ${String(e)}`);
      // 選択系は select の表示が実状態とズレるので読み直す。
      await refresh();
      return false;
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div className="space-y-4 max-w-6xl">
      <div>
        <h1 className="text-lg font-semibold">プロジェクトコード</h1>
        <p className="text-subtle text-xs mt-1">
          略称と対応リポの正本 (<code>Concordia DB / project_codes</code>)。
          Rv モードは Revisor の公開ワークフロー、所属は team_repos / subsidiary_projects と連動します。
        </p>
      </div>

      <section className="bg-surface border border-border rounded p-4">
        <h2 className="text-sm font-semibold mb-2">新規登録</h2>
        <RegisterForm onRegistered={() => void refresh()} onError={setError} />
        <p className="text-subtle text-[11px] mt-2">
          プロジェクト名と GitHub URL は指定パスの git repo から自動取得します（登録後に編集可）。
          チーム・会社は複数選択でき、未選択はそれぞれ無所属・本社のみを表します。
        </p>
      </section>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="bg-surface border border-border rounded p-4 overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[880px]">
          <thead>
            <tr className="text-[11px] text-subtle border-b border-border">
              <th className="py-1 pr-2 font-medium">略称</th>
              <th className="py-1 pr-2 font-medium">プロジェクト名</th>
              <th className="py-1 pr-2 font-medium">パス</th>
              <th className="py-1 pr-2 font-medium">GitHub URL</th>
              <th className="py-1 pr-2 font-medium">Rvモード</th>
              <th className="py-1 pr-2 font-medium">チーム</th>
              <th className="py-1 pr-2 font-medium">会社</th>
              <th className="py-1 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((entry) => (
              <EditableRow
                key={entry.code}
                entry={entry}
                data={data}
                busy={busyCode === entry.code}
                onAction={run}
                onError={setError}
              />
            ))}
            {data && data.entries.length === 0 && (
              <tr><td colSpan={8} className="py-3 text-subtle text-sm">登録がありません。</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
