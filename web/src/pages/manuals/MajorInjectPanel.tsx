import { useEffect, useState } from "react";

import {
  api,
  InjectSourceConflictError,
  type InjectSource,
  type InjectSourcesCatalog,
} from "../../api.js";

interface DraftEntry {
  base: InjectSource;
  draft: string;
  conflict: InjectSource | null;
}

const APPLY_LABEL: Record<InjectSource["apply_scope"], string> = {
  next_startup_policy: "次の起動ポリシー生成・更新から適用",
  next_session_start: "次のセッション開始から適用",
  next_delegation_launch: "次の委託起動から適用",
  next_file_read: "次に対象ファイルを読むときから適用",
};

const ORIGIN_LABEL: Record<InjectSource["origin"], string> = {
  builtin_override: "Cc の注入文面",
  inject_manuals: "既存の kind 別 Inject マニュアル",
  delegation_templates: "既存の Delegation テンプレート",
  repo_file: "リポジトリ内の規則ファイル",
};

function firstMatching(catalog: InjectSourcesCatalog, workflow: string, selectedCase?: string) {
  return catalog.sources.find((source) => source.workflow === workflow
    && (selectedCase === undefined || source.case === selectedCase));
}

export function MajorInjectPanel() {
  const [catalog, setCatalog] = useState<InjectSourcesCatalog | null>(null);
  const [entries, setEntries] = useState<Record<string, DraftEntry>>({});
  const [workflow, setWorkflow] = useState("");
  const [selectedCase, setSelectedCase] = useState("");
  const [target, setTarget] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [targetLoading, setTargetLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  async function loadCatalog() {
    setCatalogLoading(true);
    setError(null);
    try {
      const loaded = await api.injectSourcesCatalog();
      setCatalog(loaded);
      const first = loaded.sources[0];
      if (first) {
        setWorkflow((current) => current && loaded.sources.some((source) => source.workflow === current)
          ? current : first.workflow);
        setSelectedCase((current) => current && loaded.sources.some((source) => source.case === current)
          ? current : first.case);
        setTarget((current) => current && loaded.sources.some((source) => source.id === current)
          ? current : first.id);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => { void loadCatalog(); }, []);

  useEffect(() => {
    if (!target || entries[target]) return;
    let cancelled = false;
    setTargetLoading(true);
    setError(null);
    void api.injectSourceGet(target).then(({ source }) => {
      if (!cancelled) setEntries((current) => current[target]
        ? current : { ...current, [target]: { base: source, draft: source.content, conflict: null } });
    }).catch((cause) => {
      if (!cancelled) setError(String(cause));
    }).finally(() => {
      if (!cancelled) setTargetLoading(false);
    });
    return () => { cancelled = true; };
  }, [target, entries]);

  function selectWorkflow(id: string) {
    if (!catalog) return;
    const first = firstMatching(catalog, id);
    setWorkflow(id);
    setSelectedCase(first?.case ?? "");
    setTarget(first?.id ?? "");
    setError(null);
  }

  function selectCase(id: string) {
    if (!catalog) return;
    setSelectedCase(id);
    setTarget(firstMatching(catalog, workflow, id)?.id ?? "");
    setError(null);
  }

  function updateDraft(content: string) {
    setEntries((current) => {
      const entry = current[target];
      return entry ? { ...current, [target]: { ...entry, draft: content } } : current;
    });
    setSavedId(null);
  }

  async function mutate(restore: boolean) {
    const entry = entries[target];
    if (!entry) return;
    setSaving(true);
    setError(null);
    setSavedId(null);
    try {
      const { source } = restore
        ? await api.injectSourceRestore(target, entry.base.revision)
        : await api.injectSourceUpdate(target, entry.draft, entry.base.revision);
      setEntries((current) => ({ ...current, [target]: {
        base: source, draft: source.content, conflict: null,
      } }));
      setSavedId(target);
    } catch (cause) {
      if (cause instanceof InjectSourceConflictError) {
        setEntries((current) => {
          const latest = current[target];
          return latest ? { ...current, [target]: { ...latest, conflict: cause.source } } : current;
        });
      } else {
        setError(String(cause));
      }
    } finally {
      setSaving(false);
    }
  }

  function adoptLatest() {
    const entry = entries[target];
    if (!entry?.conflict) return;
    const source = entry.conflict;
    setEntries((current) => ({ ...current, [target]: {
      base: source, draft: source.content, conflict: null,
    } }));
  }

  const workflows: InjectSourcesCatalog["workflows"] = catalog?.workflows.length ? catalog.workflows
    : [...new Set(catalog?.sources.map((source) => source.workflow) ?? [])].map((id) => ({ id, label: id }));
  const cases = [...new Set(catalog?.sources.filter((source) => source.workflow === workflow)
    .map((source) => source.case) ?? [])];
  const targets = catalog?.sources.filter((source) => source.workflow === workflow && source.case === selectedCase) ?? [];
  const entry = entries[target];
  const source = entry?.base;
  const dirty = Boolean(entry && entry.draft !== entry.base.content);

  return <section className="space-y-4">
    <p className="text-subtle text-sm">主要なセッション・委託 Inject と、実際に参照される規則ファイルを編集します。保存した内容の適用時点は対象ごとに表示します。</p>
    {catalogLoading && <p role="status" className="text-subtle text-sm">編集対象を読み込み中…</p>}
    {error && <div role="alert" className="text-danger text-sm">{error} <button type="button" className="underline" onClick={() => void (catalog ? reloadTarget() : loadCatalog())}>再読込</button></div>}
    {catalog && <>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">ワークフロー
          <select className="foundation-form w-full mt-1" value={workflow} onChange={(event) => selectWorkflow(event.target.value)}>
            {workflows.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="text-sm">ケース
          <select className="foundation-form w-full mt-1" value={selectedCase} onChange={(event) => selectCase(event.target.value)}>
            {cases.map((id) => <option key={id} value={id}>{workflows.find((item) => item.id === workflow)?.cases?.find((item) => item.id === id)?.label ?? id}</option>)}
          </select>
        </label>
        <label className="text-sm">編集対象
          <select className="foundation-form w-full mt-1" value={target} onChange={(event) => { setTarget(event.target.value); setError(null); }}>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.label}{entries[item.id]?.draft !== undefined && entries[item.id]!.draft !== entries[item.id]!.base.content ? " • 未保存" : ""}</option>)}
          </select>
        </label>
      </div>
      {catalog.sources.length === 0 && <p className="text-subtle text-sm">編集対象がありません。</p>}
      {targetLoading && !entry && <p role="status" className="text-subtle text-sm">本文を読み込み中…</p>}
      {source && <article className="border border-border rounded p-3 space-y-3 bg-surface">
        <div className="text-sm space-y-1">
          <h3 className="font-semibold">{source.label}</h3>
          <div>正本: {ORIGIN_LABEL[source.origin] ?? source.origin}{source.source_path ? ` (${source.source_path})` : ""}</div>
          <div>適用: {APPLY_LABEL[source.apply_scope] ?? source.apply_scope}</div>
          <div className="text-subtle text-xs">版: {source.revision.slice(0, 12)}{source.updated_at ? ` / 更新: ${new Date(source.updated_at).toLocaleString()}` : ""}</div>
        </div>
        <label className="block text-sm">本文
          <textarea className="foundation-form w-full h-80 mt-1 font-mono text-sm" value={entry.draft}
            onChange={(event) => updateDraft(event.target.value)} disabled={saving} />
        </label>
        {source.placeholders.length > 0 && <p className="text-subtle text-xs">使用できる変数: {source.placeholders.map((name) => `[[CC:${name}]]`).join("、")}{source.required_placeholders.length > 0 ? `（必須: ${source.required_placeholders.join("、")}）` : ""}</p>}
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            disabled={!dirty || saving || !!entry.conflict} onClick={() => void mutate(false)}>保存</button>
          {source.restorable && <button type="button" className="px-3 py-1.5 rounded border border-border text-sm disabled:opacity-50"
            disabled={saving || !!entry.conflict} onClick={() => void mutate(true)}>既定に戻す</button>}
          {dirty && <span className="text-subtle text-xs">未保存の変更があります</span>}
          {savedId === target && <span role="status" className="text-ok text-xs">保存しました。{APPLY_LABEL[source.apply_scope]}</span>}
        </div>
        {entry.conflict && <div role="alert" className="border border-danger rounded p-3 space-y-2">
          <p className="text-danger text-sm">別の更新と競合しました。下書きは保持しています。最新版と比較してから読み込んでください。</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">自分の下書き<textarea className="foundation-form w-full h-32 mt-1" readOnly value={entry.draft} /></label>
            <label className="text-xs">保存済みの最新版<textarea className="foundation-form w-full h-32 mt-1" readOnly value={entry.conflict.content} /></label>
          </div>
          <button type="button" className="underline text-sm" onClick={adoptLatest}>最新版を読み込む</button>
        </div>}
      </article>}
    </>}
  </section>;

  async function reloadTarget() {
    if (!target) return;
    setError(null);
    setTargetLoading(true);
    try {
      const { source: latest } = await api.injectSourceGet(target);
      setEntries((current) => {
        const previous = current[target];
        if (previous && previous.draft !== previous.base.content) {
          return { ...current, [target]: { ...previous, conflict: latest } };
        }
        return { ...current, [target]: { base: latest, draft: latest.content, conflict: null } };
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setTargetLoading(false);
    }
  }
}
