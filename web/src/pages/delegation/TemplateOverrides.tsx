import { useEffect, useState } from "react";
import { mutate, type Template } from "./model.js";

type Override = { id: string; scope_kind: "platform" | "site"; scope_key: string; patch: Record<string, unknown>; is_active: boolean };

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
async function fetchOverrides(templateId: string, signal?: AbortSignal): Promise<Override[]> {
  const id = encodeURIComponent(templateId);
  const response = await fetch(`/v1/delegation/templates/${id}/overrides`, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json() as { overrides: Override[] }).overrides;
}

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
export function TemplateOverrides({ template, onChanged }: { template: Template; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Override[]>([]);
  const [scopeKind, setScopeKind] = useState<"platform" | "site">("platform");
  const [scopeKey, setScopeKey] = useState("darwin");
  const [patchText, setPatchText] = useState('{\n  "default_cwd": null\n}');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setError(null);
    void fetchOverrides(template.id, controller.signal)
      .then(setRows)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError((err as Error).message);
      });
    return () => controller.abort();
  }, [template.id]);

  /** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const patch: unknown = JSON.parse(patchText);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be a JSON object");
      const id = encodeURIComponent(template.id);
      const response = await mutate("PUT", `/v1/delegation/templates/${id}/overrides`, {
        scope_kind: scopeKind,
        scope_key: scopeKey,
        patch,
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      setRows(await fetchOverrides(template.id));
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
  async function remove(overrideId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const templateId = encodeURIComponent(template.id);
      const id = encodeURIComponent(overrideId);
      const response = await mutate("DELETE", `/v1/delegation/templates/${templateId}/overrides/${id}`);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      setRows(await fetchOverrides(template.id));
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function edit(row: Override): void {
    setScopeKind(row.scope_kind);
    setScopeKey(row.scope_key);
    setPatchText(JSON.stringify(row.patch, null, 2));
  }

  return <section className="rounded border border-border bg-surface p-3 space-y-2">
    <h3 className="font-semibold text-sm">Overrides — {template.call_name}</h3>
    <p className="text-xs text-subtle">base → platform → site。許可フィールド: target_provider / model / default_cwd / runtime_options_json / is_active。</p>
    {rows.map((row) => <div key={row.id} className="flex gap-2 text-xs border-t border-border pt-2"><code>{row.scope_kind}:{row.scope_key}</code><code className="flex-1 break-all">{JSON.stringify(row.patch)}</code><button disabled={busy} onClick={() => edit(row)}>編集</button><button className="text-red-500" disabled={busy} onClick={() => void remove(row.id)}>削除</button></div>)}
    <div className="grid grid-cols-2 gap-2 text-sm"><select className="foundation-form" value={scopeKind} onChange={(e) => { const kind = e.target.value as "platform" | "site"; setScopeKind(kind); setScopeKey(kind === "platform" ? "darwin" : ""); }}><option value="platform">platform</option><option value="site">site</option></select>{scopeKind === "platform" ? <select className="foundation-form" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}><option value="darwin">darwin</option><option value="win32">win32</option></select> : <input className="foundation-form" value={scopeKey} placeholder="site id" onChange={(e) => setScopeKey(e.target.value)} />}</div>
    <textarea className="foundation-form w-full font-mono text-xs" rows={4} value={patchText} onChange={(e) => setPatchText(e.target.value)} />
    {error && <div className="text-xs text-red-500">{error}</div>}<button className="border border-border px-2 py-1 rounded text-sm" disabled={busy || !scopeKey.trim()} onClick={() => void save()}>override を保存</button>
  </section>;
}
