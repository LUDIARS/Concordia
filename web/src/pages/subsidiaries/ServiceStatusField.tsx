import { useEffect, useRef, useState } from "react";
import { api, type ServiceStatusCandidates, type ServiceStatusSelection } from "../../api.js";

/** Headquarters management only; candidates are sanitized by the server before rendering. */
export function ServiceStatusField({ subsidiaryId }: { subsidiaryId: string }) {
  const [selection, setSelection] = useState<ServiceStatusSelection>({ sites: [], services: [] });
  const [candidates, setCandidates] = useState<ServiceStatusCandidates>({ sites: [], services: [] });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    let active = true; setLoaded(false); setError(null); setCandidates({ sites: [], services: [] });
    api.serviceStatusSettings(subsidiaryId).then((result) => {
      if (active) { setSelection(result.selection); setLoaded(true); }
    }).catch(() => { if (active) setError("稼働通知設定を取得できません"); });
    return () => { active = false; request.current++; };
  }, [subsidiaryId]);
  useEffect(() => {
    if (!loaded) return;
    const generation = ++request.current; let active = true;
    api.serviceStatusCandidates(subsidiaryId, selection.sites).then((result) => {
      if (active && generation === request.current) setCandidates(result);
    }).catch(() => { if (active && generation === request.current) { setCandidates({ sites: [], services: [] }); setError("稼働情報を取得できません"); } });
    return () => { active = false; };
  }, [subsidiaryId, loaded, selection.sites]);
  function toggle(kind: keyof ServiceStatusSelection, value: string) {
    setError(null);
    setSelection((current) => ({ ...current,
      [kind]: current[kind].includes(value) ? current[kind].filter((entry) => entry !== value) : [...current[kind], value],
      ...(kind === "sites" ? { services: [] } : {}),
    }));
  }
  async function save() {
    setBusy(true); setError(null);
    try { const result = await api.serviceStatusSave(subsidiaryId, selection); setSelection(result.selection); }
    catch { setError("稼働通知設定を保存できません"); }
    finally { setBusy(false); }
  }
  return <fieldset className="border-t border-border pt-2 mt-1" disabled={!loaded || busy}>
    <legend className="text-xs">サービス稼働通知</legend>
    <p className="text-[10px] text-subtle">この子会社に公開する拠点とサービスを選択。未設定は非公開。拠点変更時はサービスを選び直してください。</p>
    <div className="flex flex-wrap gap-2 my-2" aria-label="公開拠点">
      {candidates.sites.map((site) => <label key={site.id} className="text-xs"><input type="checkbox" checked={selection.sites.includes(site.id)} onChange={() => toggle("sites", site.id)} /> {site.name}</label>)}
    </div>
    <div className="flex flex-wrap gap-2 my-2" aria-label="公開サービス">
      {candidates.services.map((service) => <label key={service.key} className="text-xs"><input type="checkbox" checked={selection.services.includes(service.key)} onChange={() => toggle("services", service.key)} /> {service.siteName} / {service.name} ({service.code})</label>)}
    </div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    <button type="button" className="text-xs px-2 py-1 rounded-md border border-border" onClick={() => { void save(); }}>稼働通知設定を保存</button>
  </fieldset>;
}
