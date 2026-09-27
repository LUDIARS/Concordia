// @spec 文面の版履歴
import { useEffect, useState } from "react";

import {
  api,
  InjectSourceConflictError,
  type InjectSource,
  type InjectSourceHistoryDetail,
  type InjectSourceHistoryPage,
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

type DiffLine = { kind: "same" | "removed" | "added"; text: string };

function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  // Keep the quadratic work bounded even for a 32 KiB file made of tiny lines.
  if (left.length * right.length > 100_000) return [
    ...left.map((text): DiffLine => ({ kind: "removed", text })),
    ...right.map((text): DiffLine => ({ kind: "added", text })),
  ];
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    lengths[i]![j] = left[i] === right[j] ? lengths[i + 1]![j + 1]! + 1
      : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  }
  const lines: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i++]! }); j++;
    } else if (i < left.length && (j === right.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      lines.push({ kind: "removed", text: left[i++]! });
    } else lines.push({ kind: "added", text: right[j++]! });
  }
  return lines;
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
  const [historyPages, setHistoryPages] = useState<Record<string, InjectSourceHistoryPage>>({});
  const [selectedVersion, setSelectedVersion] = useState<{ target: string; detail: InjectSourceHistoryDetail } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

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
    void (async () => {
      const page = await api.injectSourceHistory(target);
      const { source } = await api.injectSourceGet(target);
      if (source.history_version_id == null) throw new Error("履歴の初期版を取得できませんでした");
      if (!cancelled) {
        setHistoryPages((current) => ({ ...current, [target]: page }));
        setEntries((current) => current[target]
          ? current : { ...current, [target]: { base: source, draft: source.content, conflict: null } });
      }
    })().catch((cause) => {
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
      let base = entry.base;
      if (base.history_version_id == null) {
        await api.injectSourceHistory(target);
        const { source: latest } = await api.injectSourceGet(target);
        if (latest.history_version_id == null) throw new Error("履歴の初期版を取得できませんでした");
        if (latest.revision !== base.revision || latest.content !== base.content) {
          setEntries((current) => ({ ...current, [target]: { ...current[target]!, conflict: latest } }));
          return;
        }
        base = latest;
        setEntries((current) => {
          const currentEntry = current[target];
          return currentEntry && currentEntry.base.revision === latest.revision
            && currentEntry.base.content === latest.content
            ? { ...current, [target]: { ...currentEntry, base: latest } } : current;
        });
      }
      const { source } = restore
        ? await api.injectSourceRestore(target, base.revision, base.history_version_id)
        : await api.injectSourceUpdate(target, entry.draft, base.revision, base.history_version_id);
      setEntries((current) => ({ ...current, [target]: {
        base: source, draft: source.content, conflict: null,
      } }));
      setSavedId(target);
      if (historyPages[target]) await loadHistory(target);
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

  async function loadHistory(id: string, before?: number | null) {
    setHistoryLoading(true);
    setError(null);
    try {
      const page = await api.injectSourceHistory(id, before);
      const { source: latest } = await api.injectSourceGet(id);
      setHistoryPages((current) => ({ ...current, [id]: before
        ? { ...page, versions: [...(current[id]?.versions ?? []), ...page.versions] } : page }));
      setEntries((current) => {
        const entry = current[id];
        if (!entry) return current;
        if (entry.base.revision === latest.revision && entry.base.content === latest.content
          && (entry.base.history_version_id == null
            || entry.base.history_version_id === latest.history_version_id)) {
          return { ...current, [id]: { ...entry, base: { ...entry.base,
            history_version_id: latest.history_version_id } } };
        }
        return { ...current, [id]: { ...entry, conflict: latest } };
      });
    } catch (cause) { setError(String(cause)); }
    finally { setHistoryLoading(false); }
  }

  async function selectVersion(versionId: number) {
    setHistoryLoading(true);
    setError(null);
    try {
      const detail = await api.injectSourceHistoryVersion(target, versionId);
      setSelectedVersion({ target, detail });
    } catch (cause) { setError(String(cause)); }
    finally { setHistoryLoading(false); }
  }

  async function restoreVersion() {
    const selected = selectedVersion;
    const entry = entries[target];
    if (!selected || selected.target !== target || !entry) return;
    setSaving(true);
    setError(null);
    try {
      const { source } = await api.injectSourceRestoreVersion(target, selected.detail.version.version_id,
        entry.base.revision, entry.base.history_version_id);
      setEntries((current) => ({ ...current, [target]: { base: source, draft: source.content, conflict: null } }));
      setSavedId(target);
      await loadHistory(target);
    } catch (cause) {
      if (cause instanceof InjectSourceConflictError) {
        setEntries((current) => ({ ...current, [target]: { ...current[target]!, conflict: cause.source } }));
      } else setError(String(cause));
    } finally { setSaving(false); }
  }

  async function discardDraft() {
    if (!target) return;
    setTargetLoading(true);
    setError(null);
    try {
      const { source: latest } = await api.injectSourceGet(target);
      setEntries((current) => ({ ...current, [target]: { base: latest, draft: latest.content, conflict: null } }));
    } catch (cause) { setError(String(cause)); }
    finally { setTargetLoading(false); }
  }

  async function resolveFileOutcome() {
    const pending = historyPages[target]?.pending;
    const entry = entries[target];
    if (!pending || !entry || pending.status !== "uncertain") return;
    setSaving(true);
    setError(null);
    try {
      const { source } = await api.injectSourceResolveFileOutcome(target, pending.operation_id,
        entry.base.revision, entry.base.history_version_id);
      setEntries((current) => ({ ...current, [target]: { base: source, draft: source.content, conflict: null } }));
      await loadHistory(target);
    } catch (cause) {
      if (cause instanceof InjectSourceConflictError) {
        setEntries((current) => ({ ...current, [target]: { ...current[target]!, conflict: cause.source } }));
      } else setError(String(cause));
    } finally { setSaving(false); }
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
    <p className="text-subtle text-sm">主要なセッション・委託 Inject と、実際に参照される規則ファイルを編集します。基本文面は常時残り、条件に合う拡張文面が加算されます。保存した内容の適用時点は対象ごとに表示します。</p>
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
            {targets.map((item) => <option key={item.id} value={item.id}>{item.scope_kind === "extension" ? "拡張" : "基本"} · {item.label}{entries[item.id]?.draft !== undefined && entries[item.id]!.draft !== entries[item.id]!.base.content ? " • 未保存" : ""}</option>)}
          </select>
        </label>
      </div>
      {catalog.sources.length === 0 && <p className="text-subtle text-sm">編集対象がありません。</p>}
      {targetLoading && !entry && <p role="status" className="text-subtle text-sm">本文を読み込み中…</p>}
      {source && <article className="border border-border rounded p-3 space-y-3 bg-surface">
        <div className="text-sm space-y-1">
          <h3 className="font-semibold">{source.label}</h3>
          <div>区分: {source.scope_kind === "extension" ? "拡張（条件一致時に基本へ加算）" : "基本（常時適用）"}</div>
          {source.scope_kind === "extension" && <div>適用条件: {source.apply_when ?? "条件未指定"}</div>}
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
            disabled={!dirty || saving || !!entry.conflict || !!historyPages[target]?.pending} onClick={() => void mutate(false)}>保存</button>
          {source.restorable && <button type="button" className="px-3 py-1.5 rounded border border-border text-sm disabled:opacity-50"
            disabled={saving || !!entry.conflict} onClick={() => void mutate(true)}>既定に戻す</button>}
          {dirty && <button type="button" className="underline text-sm disabled:opacity-50"
            disabled={saving || targetLoading} onClick={() => void discardDraft()}>下書きを破棄して最新版を読む</button>}
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
        <section className="border-t border-border pt-3 space-y-2" aria-label="版履歴">
          <div className="flex items-center gap-3">
            <h4 className="font-semibold text-sm">版履歴</h4>
            <button type="button" className="underline text-sm" disabled={historyLoading}
              onClick={() => void loadHistory(target)}>履歴を表示・更新</button>
            {historyLoading && <span role="status" className="text-subtle text-xs">履歴を読み込み中…</span>}
          </div>
          <p className="text-subtle text-xs">初回表示時に現在の正本を初期版として記録します。初期版の日時は取込時刻で、過去の編集者は不明です。</p>
          {historyPages[target]?.pending && <p role="alert" className="text-danger text-sm">
            ファイル操作 {historyPages[target]!.pending!.status}：結果を確定できません。対象の再保存は停止しています。
          </p>}
          {historyPages[target]?.pending?.status === "uncertain" && <div className="space-y-1 text-sm">
            <p>現在のファイルを確認したうえで正本として採用できます。元の操作が成功したとは記録せず、解決証跡を新しい版に残します。</p>
            <button type="button" className="px-3 py-1.5 rounded border border-border disabled:opacity-50"
              disabled={saving || dirty || !!entry.conflict} onClick={() => void resolveFileOutcome()}>
              現ファイルを確認して採用
            </button>
          </div>}
          {historyPages[target] && <>
            <ol className="space-y-1 max-h-48 overflow-auto text-sm">
              {historyPages[target]!.versions.map((version) => <li key={version.version_id}>
                <button type="button" className="underline text-left" onClick={() => void selectVersion(version.version_id)}>
                  #{version.version_id} · {version.change_kind} · {new Date(version.created_at).toLocaleString()} · {version.actor}
                </button>
              </li>)}
            </ol>
            {historyPages[target]!.next_before && <button type="button" className="underline text-sm"
              disabled={historyLoading} onClick={() => void loadHistory(target, historyPages[target]!.next_before)}>さらに読む</button>}
          </>}
          {selectedVersion?.target === target && <div className="space-y-2">
            <p className="text-sm">#{selectedVersion.detail.version.version_id} と直前版の差分</p>
            <pre className="max-h-80 overflow-auto border border-border rounded p-2 text-xs whitespace-pre-wrap break-words" aria-label="版の差分">
              {lineDiff(selectedVersion.detail.parent?.content ?? "", selectedVersion.detail.version.content).map((line, index) =>
                <span key={index} className={line.kind === "added" ? "text-ok" : line.kind === "removed" ? "text-danger" : "text-subtle"}>
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}{"\n"}
                </span>)}
            </pre>
            <button type="button" className="px-3 py-1.5 rounded border border-border text-sm disabled:opacity-50"
              disabled={saving || dirty || !!entry.conflict || !!historyPages[target]?.pending}
              onClick={() => void restoreVersion()}>この版を復元</button>
            {dirty && <div className="text-subtle text-xs">復元する前に下書きを保存するか、
              <button type="button" className="underline" disabled={saving || targetLoading}
                onClick={() => void discardDraft()}>下書きを破棄して最新版を読む</button> を選んでください。</div>}
          </div>}
        </section>
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
