import { useEffect, useState } from "react";
import { fmtTs, api, type ModelCatalogItem } from "../api.js";

// gamma = ローカル LLM レーン (内部は codex CLI を Ollama 経由、 推論は Gemma 等)。
type Provider = "claude" | "codex" | "gemini" | "gamma";

interface InputSchemaItem {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

interface Template {
  id: string;
  call_name: string;
  title: string;
  description: string;
  target_provider: Provider;
  model: string | null;
  prompt_template: string;
  input_schema: InputSchemaItem[];
  default_cwd: string | null;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  template_id: string | null;
  call_name: string;
  target_provider: Provider;
  args: Record<string, unknown>;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
  triggered_by: string | null;
  status: "pending" | "spawned" | "spawn_failed";
  error: string | null;
  created_at: number;
}

interface FormState {
  call_name: string;
  title: string;
  description: string;
  target_provider: Provider;
  model: string;
  prompt_template: string;
  input_schema_json: string;
  default_cwd: string;
  is_active: boolean;
}

const EMPTY_FORM: FormState = {
  call_name: "",
  title: "",
  description: "",
  target_provider: "codex",
  model: "",
  prompt_template: "",
  input_schema_json: "[]",
  default_cwd: "",
  is_active: true,
};

type FormMode = { kind: "create" } | { kind: "edit"; templateId: string };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

async function mutate(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response> {
  // Concordia は loopback (既定 127.0.0.1:17330) 限定なので bearer token は不要。
  const headers: Record<string, string> = { "content-type": "application/json" };
  return fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

export function Delegation() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invokeFor, setInvokeFor] = useState<Template | null>(null);
  const [invokeArgs, setInvokeArgs] = useState<Record<string, string>>({});
  const [invokeCwd, setInvokeCwd] = useState("");
  const [invokeResult, setInvokeResult] = useState<unknown>(null);

  async function refresh() {
    try {
      const path = includeInactive ? "/v1/delegation/templates/all" : "/v1/delegation/templates";
      const t = await getJson<{ templates: Template[] }>(path);
      setTemplates(t.templates);
      const r = await getJson<{ runs: RunRow[] }>("/v1/delegation/runs?limit=50");
      setRuns(r.runs);
      const m = await api.modelCatalogList();
      setModels(m.models);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  useEffect(() => { refresh(); }, [includeInactive]);

  function startCreate() {
    setMode({ kind: "create" });
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  function startEdit(t: Template) {
    setMode({ kind: "edit", templateId: t.id });
    setForm({
      call_name: t.call_name,
      title: t.title,
      description: t.description,
      target_provider: t.target_provider,
      model: t.model ?? "",
      prompt_template: t.prompt_template,
      input_schema_json: JSON.stringify(t.input_schema, null, 2),
      default_cwd: t.default_cwd ?? "",
      is_active: t.is_active,
    });
    setFormError(null);
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      let schema: InputSchemaItem[];
      try {
        const parsed = JSON.parse(form.input_schema_json || "[]");
        if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
        schema = parsed;
      } catch (err) {
        throw new Error(`input_schema is not valid JSON: ${(err as Error).message}`);
      }
      const body = {
        call_name: form.call_name,
        title: form.title,
        description: form.description,
        target_provider: form.target_provider,
        model: form.model.trim() ? form.model.trim() : null,
        prompt_template: form.prompt_template,
        input_schema: schema,
        default_cwd: form.default_cwd.trim() ? form.default_cwd.trim() : null,
        is_active: form.is_active,
      };
      const path = mode?.kind === "edit"
        ? `/v1/delegation/templates/${mode.templateId}`
        : "/v1/delegation/templates";
      const method = mode?.kind === "edit" ? "PATCH" : "POST";
      const r = await mutate(method, path, body);
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`${r.status} ${txt}`);
      }
      setMode(null);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string) {
    if (!confirm("Deactivate this template?")) return;
    setBusy(true);
    try {
      const r = await mutate("DELETE", `/v1/delegation/templates/${id}`, undefined);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      await refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openInvoke(t: Template) {
    setInvokeFor(t);
    const init: Record<string, string> = {};
    for (const s of t.input_schema) {
      init[s.name] = s.default !== undefined ? String(s.default) : "";
    }
    setInvokeArgs(init);
    setInvokeCwd(t.default_cwd ?? "");
    setInvokeResult(null);
  }

  async function runInvoke() {
    if (!invokeFor) return;
    setBusy(true);
    setInvokeResult(null);
    try {
      const args: Record<string, unknown> = {};
      for (const s of invokeFor.input_schema) {
        const v = invokeArgs[s.name];
        if (v === undefined || v === "") continue;
        if (s.type === "number") args[s.name] = Number(v);
        else if (s.type === "boolean") args[s.name] = v === "true";
        else args[s.name] = v;
      }
      const r = await mutate("POST", "/v1/delegation/invoke", {
        call_name: invokeFor.call_name,
        args,
        cwd: invokeCwd.trim() || undefined,
        triggered_by: "web-ui",
      });
      const data = await r.json();
      setInvokeResult(data);
      await refresh();
    } catch (err) {
      setInvokeResult({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Delegation Templates</h1>
        <p className="text-subtle text-sm">
          AI エージェント間のタスク委託テンプレ。 call_name で MCP / CLI / Web から呼び出すと、
          Concordia がプロンプトを render して新しい Codex / Claude / Gemini セッションを spawn する。
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Templates</h2>
          <label className="text-sm text-subtle flex items-center gap-1">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            include inactive
          </label>
          <button
            onClick={startCreate}
            className="ml-auto bg-accent text-bg px-3 py-1.5 rounded text-sm font-medium"
          >+ New template</button>
        </div>

        <table className="w-full text-sm">
          <thead className="text-xs text-subtle">
            <tr><th className="text-left p-2">call_name</th><th className="text-left p-2">title</th>
              <th className="text-left p-2">provider</th>
              <th className="text-left p-2">model</th>
              <th className="text-left p-2">active</th>
              <th className="text-left p-2">updated</th>
              <th className="text-right p-2">actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="p-2 font-mono">{t.call_name}</td>
                <td className="p-2">{t.title}</td>
                <td className="p-2"><code>{t.target_provider}</code></td>
                <td className="p-2 text-xs">{t.model ? <code>{t.model}</code> : <span className="text-subtle">—</span>}</td>
                <td className="p-2">{t.is_active ? "✓" : "—"}</td>
                <td className="p-2 text-xs text-subtle">{fmtTs(t.updated_at)}</td>
                <td className="p-2 text-right space-x-2">
                  <button className="text-accent text-xs" onClick={() => openInvoke(t)}>invoke</button>
                  <button className="text-xs" onClick={() => startEdit(t)}>edit</button>
                  <button className="text-red-500 text-xs" onClick={() => deactivate(t.id)}>deactivate</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {mode && (
        <section className="rounded border border-border bg-surface p-4 space-y-3">
          <h3 className="text-base font-semibold">
            {mode.kind === "edit" ? "Edit template" : "New template"}
          </h3>
          {formError && <div className="text-red-500 text-sm">{formError}</div>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-subtle">call_name (^[a-z][a-z0-9_-]{"{0,63}"}$)</span>
              <input
                className="foundation-form w-full"
                value={form.call_name}
                disabled={mode.kind === "edit"}
                onChange={(e) => setForm({ ...form, call_name: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">title</span>
              <input
                className="foundation-form w-full"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">description</span>
              <input
                className="foundation-form w-full"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">target_provider</span>
              <select
                className="foundation-form w-full"
                value={form.target_provider}
                onChange={(e) => setForm({ ...form, target_provider: e.target.value as Provider })}
              >
                <option value="codex">codex</option>
                <option value="claude">claude</option>
                <option value="gemini">gemini</option>
                <option value="gamma">gamma (ローカル LLM / Ollama)</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">model (optional)</span>
              {(() => {
                // provider に紐づく候補 (provider 一致 + 'any') を sort_order 順で。
                const opts = models.filter(
                  (m) => m.provider === "any" || m.provider === form.target_provider,
                );
                // 既存テンプレが catalog に無いモデルを持つ場合、 値を失わないよう
                // 末尾に現値を補う (編集時の互換)。
                const known = new Set(opts.map((m) => m.model_id));
                const hasCurrent = form.model.trim() !== "";
                return (
                  <>
                    <select
                      className="foundation-form w-full"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                    >
                      <option value="">(provider CLI 既定)</option>
                      {opts.map((m) => (
                        <option key={m.id} value={m.model_id}>
                          {m.label ? `${m.label} — ${m.model_id}` : m.model_id}
                          {m.provider !== "any" ? "" : " (any)"}
                        </option>
                      ))}
                      {hasCurrent && !known.has(form.model) && (
                        <option value={form.model}>{form.model} (未登録)</option>
                      )}
                    </select>
                    {models.length === 0 && (
                      <span className="text-xs text-subtle">
                        モデル候補が未登録です。 設定 → モデルカタログ で追加できます。
                      </span>
                    )}
                  </>
                );
              })()}
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">default_cwd (optional)</span>
              <input
                className="foundation-form w-full"
                value={form.default_cwd}
                onChange={(e) => setForm({ ...form, default_cwd: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">prompt_template (${'{var}'} or ${'{var:default}'})</span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={10}
                value={form.prompt_template}
                onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">
                input_schema (JSON array of {"{name,type,required,description?,default?}"})
              </span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={6}
                value={form.input_schema_json}
                onChange={(e) => setForm({ ...form, input_schema_json: e.target.value })}
              />
            </label>
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              <span>is_active</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            >Save</button>
            <button
              onClick={() => { setMode(null); setForm(EMPTY_FORM); }}
              disabled={busy}
              className="text-sm px-4 py-1.5 rounded border border-border"
            >Cancel</button>
          </div>
        </section>
      )}

      {invokeFor && (
        <section className="rounded border border-border bg-surface p-4 space-y-3">
          <h3 className="text-base font-semibold">Invoke {invokeFor.call_name}</h3>
          <p className="text-xs text-subtle">{invokeFor.description}</p>
          <div className="grid grid-cols-2 gap-3">
            {invokeFor.input_schema.map((s) => (
              <label key={s.name} className="text-sm space-y-1">
                <span className="text-subtle">
                  {s.name} <span className="font-mono text-xs">{s.type}</span>
                  {s.required && <span className="text-red-500"> *</span>}
                  {s.description && <div className="text-xs text-subtle">{s.description}</div>}
                </span>
                <input
                  className="foundation-form w-full"
                  value={invokeArgs[s.name] ?? ""}
                  onChange={(e) => setInvokeArgs({ ...invokeArgs, [s.name]: e.target.value })}
                />
              </label>
            ))}
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">cwd (optional override)</span>
              <input
                className="foundation-form w-full"
                value={invokeCwd}
                onChange={(e) => setInvokeCwd(e.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runInvoke}
              disabled={busy}
              className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            >Spawn</button>
            <button
              onClick={() => { setInvokeFor(null); setInvokeResult(null); }}
              disabled={busy}
              className="text-sm px-4 py-1.5 rounded border border-border"
            >Close</button>
          </div>
          {invokeResult !== null && (
            <pre className="text-xs bg-bg p-3 rounded overflow-auto max-h-96">
              {JSON.stringify(invokeResult, null, 2)}
            </pre>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="text-left p-2">call_name</th>
              <th className="text-left p-2">status</th>
              <th className="text-left p-2">spawn pid</th>
              <th className="text-left p-2">triggered_by</th>
              <th className="text-left p-2">created</th>
              <th className="text-left p-2">prompt file</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2 font-mono text-xs">{r.call_name}</td>
                <td className="p-2"><code>{r.status}</code></td>
                <td className="p-2">{r.spawn_pid ?? "—"}</td>
                <td className="p-2 text-xs">{r.triggered_by ?? "—"}</td>
                <td className="p-2 text-xs text-subtle">{fmtTs(r.created_at)}</td>
                <td className="p-2 text-xs font-mono">{r.prompt_file_path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
