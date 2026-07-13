import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, api, statusBadge, type ModelCatalogItem, type SessionRow } from "../../api.js";
import { RuntimeOptionsBuilder } from "../../components/RuntimeOptionsBuilder.js";
import { EMPTY_FORM, getJson, mutate, type DelegationOptionSuggestion, type FormMode, type FormState, type InputSchemaItem, type QueueState, type RunRow, type Template } from "./model.js";

export function useDelegationState() {
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
  // 実行キュー (同時実行上限 + 待ち行列)。
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [queueLimitDraft, setQueueLimitDraft] = useState("");

  async function refresh() {
    try {
      const path = includeInactive ? "/v1/delegation/templates/all" : "/v1/delegation/templates";
      const t = await getJson<{ templates: Template[] }>(path);
      setTemplates(t.templates);
      // 外注は完了しても残す方針なので、 履歴が直近 50 件で切れないよう多めに取る。
      const r = await getJson<{ runs: RunRow[] }>("/v1/delegation/runs?limit=200");
      setRuns(r.runs);
      const m = await api.modelCatalogList();
      setModels(m.models);
      const q = await getJson<QueueState>("/v1/delegation/queue");
      setQueue(q);
      setQueueLimitDraft(String(q.max_concurrency));
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  /** 同時実行上限を保存する。 引き上げ/解除ならサーバ側が待ち行列をその場で流す。 */
  async function saveQueueLimit() {
    const n = Math.max(0, Math.floor(Number(queueLimitDraft) || 0));
    const res = await mutate("PATCH", "/v1/delegation/queue", { max_concurrency: n });
    if (!res.ok) {
      setFormError(`キュー設定の保存に失敗: ${res.status} ${res.statusText}`);
      return;
    }
    await refresh();
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
      category: t.category ?? "employee",
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
        category: form.category,
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
  // まだ spawn されていない待ち行列 (上の外注一覧には spawn_pid が無いので出てこない)。
  const queuedRuns = runs
    .filter((r) => r.status === "queued")
    .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
  // 外注は「終わっても残す」。 進行中と完了済み (履歴) を分けて、 完了分が新着に押し流されて
  // 見えなくなるのを防ぐ。 run 行自体は DB から消さない (セッションと違い purge 対象外)。
  const FINISHED: RunRow["status"][] = ["completed", "failed", "spawn_failed"];
  const activeOutsourced = outsourcedRuns.filter((r) => !FINISHED.includes(r.status));
  const finishedOutsourced = outsourcedRuns.filter((r) => FINISHED.includes(r.status));

  return { templates, models, runs, includeInactive, setIncludeInactive, mode, setMode, form, setForm, formRuntimeOptions, setFormRuntimeOptions, formError, busy, invokeFor, setInvokeFor, invokeArgs, setInvokeArgs, invokeOptionsJson, setInvokeOptionsJson, invokeCwd, setInvokeCwd, invokeResult, setInvokeResult, importText, setImportText, queue, queueLimitDraft, setQueueLimitDraft, saveQueueLimit, safeRuntimeOptions, optionValueForJson, setFormRuntimeOption, startCreate, startEdit, submit, copyJson, importJson, deactivate, moveTemplate, openInvoke, runInvoke, outsourcedRuns, queuedRuns, activeOutsourced, finishedOutsourced };
}
