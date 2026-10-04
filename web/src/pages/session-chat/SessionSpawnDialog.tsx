import { useEffect, useRef, useState } from "react";
import { DelegationSpawnForm } from "../../components/DelegationSpawnForm.js";
import { api, type Department, type SubsidiarySummary } from "../../api.js";

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
export function SessionSpawnDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [locations, setLocations] = useState<{ departments: Department[]; companies: SubsidiarySummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([api.departmentsList({ allOrganizations: true }), api.subsidiariesList()])
      .then(([departments, companies]) => {
        if (!cancelled) setLocations({ departments: departments.departments, companies: companies.subsidiaries });
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [loadAttempt]);
  const departments = locations?.departments.filter((item) => !item.archived && (item.subsidiary_id ?? "") === companyId) ?? [];
  const department = departments.find((item) => item.id === departmentId) ?? null;
  return (
    <dialog ref={dialog} onClose={onClose} aria-label="新規セッション"
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded border border-border bg-surface p-4 text-text backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">新規セッション</h2>
        <button type="button" onClick={onClose} aria-label="新規セッションを閉じる">×</button>
      </div>
      {error && <div role="alert" className="mb-3 text-sm text-danger">起動先を取得できません: {error} <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>再試行</button></div>}
      {!locations && !error && <p role="status" className="text-sm text-subtle">起動先を読み込み中…</p>}
      {locations && <>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-subtle"><span>起動先の会社</span>
            <select className="foundation-form w-full text-sm" value={companyId} disabled={submitting} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(""); }}>
              <option value="">本社</option>
              {locations.companies.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-subtle"><span>起動部署</span>
            <select className="foundation-form w-full text-sm" value={departmentId} disabled={submitting} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="">会社の既定部署</option>
              {departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        <DelegationSpawnForm key={`${companyId}:${departmentId}`} subsidiaryId={companyId || null} department={department} onSpawned={onClose} onSubmittingChange={setSubmitting} />
      </>}
    </dialog>
  );
}
