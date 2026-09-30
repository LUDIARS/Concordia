// @implements SPEC-DEPT-WEBUI
import { useEffect, useState } from "react";

import { api, type Department, type SubsidiarySummary, type UseCase } from "../api.js";
import { DepartmentEditor } from "./departments/DepartmentEditor.js";

// 部署管理 (spec/feature/departments.md §8)。 会社 (本社 / 各子会社) を選び、部署の作成・
// 編集・廃止・復帰を行う。 所有会社は作成時に固定され、あとから移せない。

const HEAD_OFFICE = "";

export function Departments() {
  const [organization, setOrganization] = useState(HEAD_OFFICE);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.subsidiariesList().then((r) => setSubsidiaries(r.subsidiaries)).catch(() => setSubsidiaries([]));
    api.useCasesList().then((r) => setUseCases(r.use_cases)).catch(() => setUseCases([]));
  }, []);

  const refresh = async () => {
    try {
      const r = await api.departmentsList({ subsidiaryId: organization || null, includeArchived: true });
      setDepartments(r.departments);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [organization]);

  const create = async () => {
    try {
      const r = await api.departmentCreate({ name: newName.trim(), slug: newSlug.trim(), subsidiary_id: organization || null });
      setNewName("");
      setNewSlug("");
      setOpenId(r.department.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleArchive = async (department: Department) => {
    try {
      if (department.archived) await api.departmentRestore(department.id);
      else await api.departmentArchive(department.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const replace = (updated: Department) => {
    setDepartments((current) => current.map((d) => (d.id === updated.id ? updated : d)));
    void refresh();
  };

  return (
    <div className="space-y-4 max-w-5xl">
      <header>
        <h1 className="text-lg font-semibold">部署</h1>
        <p className="text-subtle text-sm mt-1">
          会社の下でセッションを束ね、起動既定値・ユースケース・出力方針・ルールを部署ごとに分けます。
          既定でない部署は Discord の「部署」カテゴリにフォーラムを持ち、投稿するとその部署のセッションが起動します。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">会社</span>
          <select className="foundation-form text-sm" value={organization} onChange={(e) => { setOrganization(e.target.value); setOpenId(null); }}>
            <option value={HEAD_OFFICE}>本社</option>
            {subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.name}</option>)}
          </select>
        </label>
        <input className="foundation-form text-sm" placeholder="新しい部署名" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className="foundation-form text-sm" placeholder="slug (例: tech-qa)" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} />
        <button
          type="button"
          className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50"
          disabled={!newName.trim() || !newSlug.trim()}
          onClick={() => void create()}
        >
          作成
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}
      {departments.length === 0 && <div className="text-subtle text-sm">この会社の部署はまだありません。</div>}

      <div className="space-y-2">
        {departments.map((department) => (
          <section key={department.id} className="border border-border rounded bg-surface">
            <div className="flex items-center gap-2 px-3 py-2">
              <button type="button" className="font-medium text-left" onClick={() => setOpenId(openId === department.id ? null : department.id)}>
                {department.name}
              </button>
              <span className="text-xs text-subtle">{department.slug}</span>
              {department.is_default && <span className="text-[10px] rounded bg-muted px-1.5 py-0.5">既定</span>}
              {department.archived && <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-subtle">廃止</span>}
              {department.use_case_id && (
                <span className="text-xs text-subtle">
                  ユースケース: {useCases.find((u) => u.id === department.use_case_id)?.name ?? department.use_case_id}
                </span>
              )}
              <button type="button" className="ml-auto text-xs text-accent" onClick={() => void toggleArchive(department)}>
                {department.archived ? "復帰" : "廃止"}
              </button>
            </div>
            {openId === department.id && (
              <div className="border-t border-border px-3 py-3">
                <DepartmentEditor department={department} useCases={useCases} onSaved={replace} />
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
