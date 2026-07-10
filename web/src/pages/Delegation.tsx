import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, api, statusBadge, type ModelCatalogItem, type SessionRow } from "../api.js";
import { RuntimeOptionsBuilder } from "../components/RuntimeOptionsBuilder.js";

// gemma4-12 = ローカル LLM レーン (旧名 gamma。 内部は codex CLI を Ollama 経由、 推論は Gemma)。
type Provider = "claude" | "codex" | "gemini" | "gemma4-12";

interface InputSchemaItem {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

interface DelegationOptionChoice {
  label: string;
  value: string;
  description?: string;
}

interface DelegationOptionSuggestion {
  key: string;
  label: string;
  type: "select" | "string" | "boolean" | "number";
  description?: string;
  choices?: DelegationOptionChoice[];
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
  project: string | null;
  is_active: boolean;
  emoji: string;
  call_only: boolean;
  sort_order: number;
  default_options?: Record<string, unknown>;
  runtime_options?: DelegationOptionSuggestion[];
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
  sessions?: SessionRow[];
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
  project: string;
  runtime_options_json: string;
  is_active: boolean;
  emoji: string;
  call_only: boolean;
  sort_order: string;
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
  project: "",
  runtime_options_json: "{}",
  is_active: true,
  emoji: "",
  call_only: false,
  sort_order: "1000",
};

type FormMode = { kind: "create" } | { kind: "edit"; templateId: string };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

async function mutate(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response> {
  // Concordia は loopback (既定 127.0.0.1:11111) 限定なので bearer token は不要。
  const headers: Record<string, string> = { "content-type": "application/json" };
  return fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstLine(text: string | null): string | null {
  if (!text) return null;
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function runSummary(r: RunRow): string {
  return (
    firstLine(stringArg(r.args, "context_extra")) ??
    firstLine(stringArg(r.args, "task")) ??
    stringArg(r.args, "design_path") ??
    r.call_name
  );
}

function runTarget(r: RunRow): string | null {
  return stringArg(r.args, "target_repo") ?? stringArg(r.args, "repo_path") ?? stringArg(r.args, "cwd");
}

function formatDuration(s: SessionRow): string {
  if (!s.ended_at) return "active";
  const seconds = Math.max(0, s.ended_at - s.started_at);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest}s`;
}

function fmtDelegationTs(ts: number): string {
  return fmtTs(ts > 10_000_000_000 ? Math.floor(ts / 1000) : ts);
}

export function Delegation() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formRuntimeOptions, setFormRuntimeOptions] = useState<DelegationOptionSuggestion[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invokeFor, setInvokeFor] = useState<Template | null>(null);
  const [invokeArgs, setInvokeArgs] = useState<Record<string, string>>({});
  const [invokeOptionsJson, setInvokeOptionsJson] = useState("{}");
  const [invokeCwd, setInvokeCwd] = useState("");
  const [invokeResult, setInvokeResult] = useState<unknown>(null);
  // 可搬 JSON の貼付欄 (null = 非表示)。
  const [importText, setImportText] = useState<string | null>(null);

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

  useEffect(() => {
    if (!mode) {
      setFormRuntimeOptions([]);
      return;
    }
    let cancelled = false;
    api.delegationOptions(form.target_provider, form.model)
      .then((r) => {
        if (!cancelled) setFormRuntimeOptions(r.suggestions);
      })
      .catch(() => {
        if (!cancelled) setFormRuntimeOptions([]);
      });
    return () => { cancelled = true; };
  }, [mode, form.target_provider, form.model]);

  function parseRuntimeOptionsJson(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("runtime_options must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  function safeRuntimeOptions(text: string): Record<string, unknown> {
    try {
      return parseRuntimeOptionsJson(text);
    } catch {
      return {};
    }
  }

  function optionValueForJson(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
  }

  function setFormRuntimeOption(opt: DelegationOptionSuggestion, raw: string) {
    const options = safeRuntimeOptions(form.runtime_options_json);
    if (raw === "") {
      delete options[opt.key];
    } else if (opt.type === "number") {
      options[opt.key] = Number(raw);
    } else if (opt.type === "boolean") {
      options[opt.key] = raw === "true";
    } else {
      options[opt.key] = raw;
    }
    setForm({ ...form, runtime_options_json: JSON.stringify(options, null, 2) });
  }

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
      project: t.project ?? "",
      runtime_options_json: JSON.stringify(t.default_options ?? {}, null, 2),
      is_active: t.is_active,
      emoji: t.emoji ?? "",
      call_only: t.call_only ?? false,
      sort_order: String(t.sort_order ?? 1000),
    });
    setFormError(null);
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      let schema: InputSchemaItem[];
      let runtimeOptions: Record<string, unknown>;
      try {
        const parsed = JSON.parse(form.input_schema_json || "[]");
        if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
        schema = parsed;
      } catch (err) {
        throw new Error(`input_schema is not valid JSON: ${(err as Error).message}`);
      }
      try {
        runtimeOptions = parseRuntimeOptionsJson(form.runtime_options_json);
      } catch (err) {
        throw new Error(`runtime_options is not valid JSON: ${(err as Error).message}`);
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
        project: form.project.trim() ? form.project.trim() : null,
        runtime_options: runtimeOptions,
        is_active: form.is_active,
        emoji: form.emoji,
        call_only: form.call_only,
        sort_order: Number(form.sort_order) || 0,
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

  // 1 つの delegation を可搬 JSON でクリップボードにコピーする。
  async function copyJson(t: Template) {
    try {
      const { delegation } = await getJson<{ delegation: unknown }>(`/v1/delegation/templates/${t.id}/export`);
      await navigator.clipboard.writeText(JSON.stringify(delegation, null, 2));
      setFormError(null);
    } catch (err) {
      setFormError(`JSON copy 失敗: ${(err as Error).message}`);
    }
  }

  // 貼付された可搬 JSON から新規テンプレを作成する (call_name は自動採番で衝突回避)。
  async function importJson() {
    setBusy(true);
    setFormError(null);
    try {
      const body = JSON.parse(importText || "{}");
      const r = await mutate("POST", "/v1/delegation/templates/import", body);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setImportText(null);
      await refresh();
    } catch (err) {
      setFormError(`import 失敗: ${(err as Error).message}`);
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

  async function moveTemplate(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= templates.length) return;
    const reordered = templates.slice();
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
    setBusy(true);
    setFormError(null);
    try {
      for (let i = 0; i < reordered.length; i++) {
        const sort_order = (i + 1) * 10;
        if (reordered[i].sort_order === sort_order) continue;
        const r = await mutate("PATCH", `/v1/delegation/templates/${reordered[i].id}`, { sort_order });
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      }
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
    // テンプレの default_options を初期値として JSON (単一の正本) に展開する。
    // ビルダーと textarea は同じ JSON を編集するビュー。
    setInvokeOptionsJson(JSON.stringify(t.default_options ?? {}, null, 2));
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
      let options: Record<string, unknown> = {};
      const rawOptionsJson = invokeOptionsJson.trim();
      if (rawOptionsJson && rawOptionsJson !== "{}") {
        const parsed = JSON.parse(rawOptionsJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("runtime options JSON must be an object");
        }
        options = parsed as Record<string, unknown>;
      }
      const hasOptions = Object.keys(options).length > 0;
      const r = await mutate("POST", "/v1/delegation/invoke", {
        call_name: invokeFor.call_name,
        args,
        cwd: invokeCwd.trim() || undefined,
        triggered_by: "web-ui",
        options: hasOptions ? options : undefined,
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

  const outsourcedRuns = runs.filter((r) => r.spawn_pid !== null || (r.sessions?.length ?? 0) > 0);

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
          <button
            onClick={() => setImportText(importText === null ? "" : null)}
            className="border border-border px-3 py-1.5 rounded text-sm"
            title="可搬 JSON を貼り付けてテンプレを作成"
          >貼付で作成</button>
        </div>

        {importText !== null && (
          <div className="mb-3 rounded border border-border bg-surface p-3 space-y-2">
            <div className="text-xs text-subtle">📋JSON でコピーした可搬 delegation を貼り付け → 作成 (call_name は自動採番)</div>
            <textarea
              className="foundation-form w-full font-mono text-xs"
              rows={6}
              placeholder='{"kind":"concordia.delegation","call_name":"...","target_provider":"claude", ...}'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="bg-accent text-bg px-3 py-1 rounded text-sm" disabled={busy || !importText.trim()} onClick={importJson}>作成</button>
              <button className="border border-border px-3 py-1 rounded text-sm" onClick={() => setImportText(null)}>閉じる</button>
            </div>
          </div>
        )}

        <table className="w-full text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="text-left p-2">call_name</th>
              <th className="text-left p-2">title</th>
              <th className="text-right p-2">order</th>
              <th className="text-left p-2">provider</th>
              <th className="text-left p-2">model</th>
              <th className="text-center p-2">emoji</th>
              <th className="text-center p-2">active</th>
              <th className="text-center p-2" title="call_only=true はスポーン選択肢に出ない">call only</th>
              <th className="text-left p-2">updated</th>
              <th className="text-right p-2">actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <tr key={t.id} className="border-t border-border">
                <td className="p-2 font-mono">{t.call_name}</td>
                <td className="p-2">{t.title}</td>
                <td className="p-2 text-right text-xs text-subtle">{t.sort_order}</td>
                <td className="p-2"><code>{t.target_provider}</code></td>
                <td className="p-2 text-xs">{t.model ? <code>{t.model}</code> : <span className="text-subtle">—</span>}</td>
                <td className="p-2 text-center">{t.emoji || <span className="text-subtle">—</span>}</td>
                <td className="p-2 text-center">{t.is_active ? "✓" : "—"}</td>
                <td className="p-2 text-center">{t.call_only ? "✓" : "—"}</td>
                <td className="p-2 text-xs text-subtle">{fmtDelegationTs(t.updated_at)}</td>
                <td className="p-2 text-right space-x-2">
                  <button className="text-xs" disabled={busy || i === 0} title="Move up" onClick={() => moveTemplate(i, -1)}>↑</button>
                  <button className="text-xs" disabled={busy || i === templates.length - 1} title="Move down" onClick={() => moveTemplate(i, 1)}>↓</button>
                  <button className="text-accent text-xs" onClick={() => openInvoke(t)}>invoke</button>
                  <button className="text-xs" onClick={() => startEdit(t)}>edit</button>
                  <button className="text-xs" title="可搬 JSON をクリップボードにコピー" onClick={() => copyJson(t)}>📋JSON</button>
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
                <option value="gemma4-12">gemma4-12 (ローカル LLM / Ollama)</option>
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
            <div className="text-sm space-y-2 col-span-2 rounded border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-subtle">default runtime options</span>
                <span className="text-xs text-subtle">
                  {formRuntimeOptions.length > 0
                    ? `${form.target_provider}${form.model.trim() ? ` / ${form.model.trim()}` : ""}`
                    : "no suggestions for selected provider/model"}
                </span>
              </div>
              <RuntimeOptionsBuilder
                suggestions={formRuntimeOptions}
                json={form.runtime_options_json}
                onJsonChange={(j) => setForm({ ...form, runtime_options_json: j })}
              />
              <label className="block space-y-1">
                <span className="text-subtle">runtime_options JSON</span>
                <textarea
                  className="foundation-form w-full font-mono text-xs"
                  rows={4}
                  value={form.runtime_options_json}
                  onChange={(e) => setForm({ ...form, runtime_options_json: e.target.value })}
                />
              </label>
            </div>
            <label className="text-sm space-y-1">
              <span className="text-subtle">default_cwd (optional)</span>
              <input
                className="foundation-form w-full"
                value={form.default_cwd}
                onChange={(e) => setForm({ ...form, default_cwd: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">project (対象プロジェクト名、省略可)</span>
              <input
                className="foundation-form w-full"
                value={form.project}
                onChange={(e) => setForm({ ...form, project: e.target.value })}
                placeholder="Pictor"
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">sort_order</span>
              <input
                className="foundation-form w-full"
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
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
            <label className="text-sm space-y-1">
              <span className="text-subtle">emoji (チャット表示用、省略可)</span>
              <input
                className="foundation-form w-full"
                value={form.emoji}
                onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                placeholder="🧙‍♂️"
                maxLength={8}
              />
            </label>
            <div className="text-sm flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                <span>is_active</span>
              </label>
              <label className="flex items-center gap-2" title="LLM 委託専用。 Discord/Slack の spawn ドロップダウンに出さない">
                <input
                  type="checkbox"
                  checked={form.call_only}
                  onChange={(e) => setForm({ ...form, call_only: e.target.checked })}
                />
                <span>call_only</span>
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            >Save</button>
            <button
              onClick={() => { setMode(null); setForm(EMPTY_FORM); setFormRuntimeOptions([]); }}
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
            <div className="col-span-2">
              <RuntimeOptionsBuilder
                suggestions={invokeFor.runtime_options ?? []}
                json={invokeOptionsJson}
                onJsonChange={setInvokeOptionsJson}
              />
            </div>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">runtime options JSON</span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={3}
                value={invokeOptionsJson}
                onChange={(e) => setInvokeOptionsJson(e.target.value)}
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

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">外注(作業委託)</h2>
          <span className="text-xs text-subtle">{outsourcedRuns.length} tasks</span>
        </div>
        {outsourcedRuns.length === 0 ? (
          <div className="border border-border rounded p-3 text-sm text-subtle">外注タスクはありません</div>
        ) : (
          <div className="grid gap-2">
            {outsourcedRuns.map((r) => {
              const target = runTarget(r);
              const linkedSessions = r.sessions ?? [];
              return (
                <article key={r.id} className="border border-border rounded bg-surface p-3">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-xs px-1.5 py-0.5 rounded bg-bg">{r.call_name}</code>
                        <code className="text-xs px-1.5 py-0.5 rounded bg-bg">{r.status}</code>
                        <span className="text-xs text-subtle">{fmtDelegationTs(r.created_at)}</span>
                      </div>
                      <div className="text-sm break-words">{runSummary(r)}</div>
                      {target && <div className="text-xs text-subtle break-all">{target}</div>}
                    </div>
                    <div className="text-xs text-subtle lg:text-right shrink-0">
                      <div>pid {r.spawn_pid ?? "-"}</div>
                      <div>{r.triggered_by ?? "-"}</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs font-mono text-subtle break-all">{r.prompt_file_path}</div>
                  {linkedSessions.length > 0 ? (
                    <div className="mt-3 border-t border-border divide-y divide-border">
                      {linkedSessions.map((s) => (
                        <div key={s.id} className="py-2 grid gap-1 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                to={`/sessions/${encodeURIComponent(s.id)}`}
                                className="font-mono text-xs text-accent hover:underline break-all"
                              >
                                {s.id}
                              </Link>
                              <span className={`px-1.5 py-0.5 rounded text-xs ${statusBadge(s.status)}`}>{s.status}</span>
                              <span className="text-xs text-subtle">{s.provider}</span>
                              <span className="text-xs text-subtle">{formatDuration(s)}</span>
                            </div>
                            <div className="text-xs text-subtle break-all">{s.repo_path}</div>
                            {s.current_task && <div className="text-xs break-words mt-1">{s.current_task}</div>}
                          </div>
                          <div className="text-xs text-subtle md:text-right">
                            <div>{s.branch ?? "-"}</div>
                            <div>{fmtDelegationTs(s.started_at)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 border-t border-border pt-2 text-xs text-subtle">紐付いた Cc session はありません</div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

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
                <td className="p-2 text-xs text-subtle">{fmtDelegationTs(r.created_at)}</td>
                <td className="p-2 text-xs font-mono">{r.prompt_file_path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
