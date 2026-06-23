import { useEffect, useMemo, useState } from "react";
import {
  api,
  fmtTs,
  type LibrarySnapshot,
  type LibrarySource,
  type LibraryBlock,
  type LibraryAnalyzeResult,
  type ArchivePlanItem,
  type ArchivedRecord,
} from "../api.js";

/**
 * Library Hygiene — Castra / 各プロジェクトの `.claude` のメモリ/スキルを棚卸しする。
 * 現状サマリ + 過多警告 + ブロック単位の退避 (dry-run→apply) + 矛盾/整理サジェスト (LLM、提案のみ)
 * + 退避台帳の閲覧/復帰。 退避は完全削除せず `_archive/` へ move する。
 */
export function Library() {
  const [snap, setSnap] = useState<LibrarySnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ArchivePlanItem[] | null>(null);
  const [reason, setReason] = useState("");
  const [analyze, setAnalyze] = useState<Record<string, LibraryAnalyzeResult>>({});
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [archived, setArchived] = useState<Record<string, ArchivedRecord[]>>({});

  const load = () => {
    setBusy(true);
    setErr(null);
    api
      .library()
      .then((s) => {
        setSnap(s);
        setPlan(null);
        setSelected(new Set());
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  // id → block の対応 (selection 解決用)。
  const blockById = useMemo(() => {
    const m = new Map<string, LibraryBlock>();
    for (const src of snap?.sources ?? []) for (const b of src.blocks) m.set(b.id, b);
    return m;
  }, [snap]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const addMany = (ids: string[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (blockById.has(id)) next.add(id);
      return next;
    });

  const selectedRefs = (): Array<{ sourceId: string; name: string }> =>
    [...selected]
      .map((id) => blockById.get(id))
      .filter((b): b is LibraryBlock => !!b)
      .map((b) => ({ sourceId: b.sourceId, name: b.name }));

  const doDryRun = () => {
    const blocks = selectedRefs();
    if (blocks.length === 0) return;
    setBusy(true);
    setErr(null);
    api
      .libraryArchive(blocks, {})
      .then((r) => setPlan(r.items))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };

  const doApply = () => {
    const blocks = selectedRefs();
    if (blocks.length === 0) return;
    if (!confirm(`${blocks.length} 件を _archive/ へ退避します (完全削除ではありません)。実行しますか?`)) return;
    setBusy(true);
    setErr(null);
    api
      .libraryArchive(blocks, { apply: true, reason: reason.trim() || undefined })
      .then(() => {
        setReason("");
        load();
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };

  const runAnalyze = (sourceId: string) => {
    setAnalyzing(sourceId);
    api
      .libraryAnalyze(sourceId)
      .then((r) => setAnalyze((prev) => ({ ...prev, [sourceId]: r })))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setAnalyzing(null));
  };

  const loadArchived = (sourceId: string) => {
    api
      .libraryArchived(sourceId)
      .then((r) => setArchived((prev) => ({ ...prev, [sourceId]: r.archived })))
      .catch((e) => setErr((e as Error).message));
  };

  const doRestore = (sourceId: string, blockId: string, name: string) => {
    if (!confirm(`"${name}" を退避から戻しますか?`)) return;
    api
      .libraryRestore([{ sourceId, blockId }])
      .then(() => {
        loadArchived(sourceId);
        load();
      })
      .catch((e) => setErr((e as Error).message));
  };

  const warnings = (snap?.findings ?? []).filter((f) => f.level === "warn");
  const infos = (snap?.findings ?? []).filter((f) => f.level === "info");

  return (
    <div className="max-w-6xl space-y-4">
      <header>
        <h1 className="font-semibold">メモリ/スキル整理 (Library Hygiene)</h1>
        <p className="text-subtle text-sm mt-1">
          Castra と各プロジェクトの <code>.claude</code> のメモリ (<code>memory/*.md</code> + <code>MEMORY.md</code>)
          とスキルを棚卸しします。 退避は完全削除せず <code>_archive/</code> へ移動 + 台帳記録 (= 読めるが自動ロード対象外)。
          矛盾検査/自動整理は提案までで自動適用しません。
        </p>
      </header>

      <div className="flex items-center gap-2">
        <button
          onClick={load}
          disabled={busy}
          className="text-sm border border-border rounded px-3 py-1.5 hover:border-accent/50 disabled:opacity-50"
        >
          {busy ? "走査中…" : "⟳ 再走査"}
        </button>
        {snap && (
          <span className="text-xs text-subtle">
            {snap.summary.totalSources} sources · {snap.summary.totalBlocks} blocks
            (memory {snap.summary.memoryBlocks} / skill {snap.summary.skillBlocks}) ·{" "}
            {(snap.summary.totalBytes / 1024).toFixed(0)}KB ·{" "}
            <span className={warnings.length ? "text-warn" : "text-ok"}>warn {warnings.length}</span>{" "}
            / info {infos.length}
          </span>
        )}
      </div>

      {err && <div className="text-danger text-sm">error: {err}</div>}
      {!snap && !err && <div className="text-subtle text-sm">loading…</div>}

      {/* 警告パネル */}
      {warnings.length > 0 && (
        <section className="bg-surface border border-warn/40 rounded p-3">
          <h2 className="text-sm font-medium text-warn mb-1">⚠ 警告 ({warnings.length})</h2>
          <ul className="space-y-0.5">
            {warnings.map((f, i) => (
              <li key={i} className="text-xs text-warn">
                [{f.code}] {f.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 退避バー */}
      {selected.size > 0 && (
        <section className="bg-surface border border-accent/40 rounded p-3 space-y-2 sticky top-2 z-10">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{selected.size} 件選択中</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="退避理由 (任意、台帳に残る)"
              className="foundation-form text-xs border border-border rounded px-2 py-1 flex-1 min-w-[12rem] bg-bg"
            />
            <button
              onClick={doDryRun}
              disabled={busy}
              className="text-xs border border-border rounded px-3 py-1.5 hover:border-accent/50 disabled:opacity-50"
            >
              退避プレビュー (dry-run)
            </button>
            <button
              onClick={doApply}
              disabled={busy}
              className="text-xs border border-accent/60 text-accent rounded px-3 py-1.5 hover:bg-accent/10 disabled:opacity-50"
            >
              退避を実行
            </button>
            <button
              onClick={() => {
                setSelected(new Set());
                setPlan(null);
              }}
              className="text-xs text-subtle hover:text-fg"
            >
              選択解除
            </button>
          </div>
          {plan && (
            <ul className="space-y-0.5 border-t border-border pt-2">
              {plan.map((p, i) => (
                <li key={i} className={`text-xs ${p.ok ? "text-ok" : "text-danger"}`}>
                  {p.ok ? "✓" : "✗"} {p.name} — {p.action}
                  {p.warnings.length > 0 && (
                    <span className="text-warn"> ({p.warnings.join("; ")})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* source 別ブロック */}
      <div className="space-y-3">
        {snap?.sources.map((src) => (
          <SourceCard
            key={src.id}
            src={src}
            selected={selected}
            onToggle={toggle}
            analyze={analyze[src.id]}
            analyzing={analyzing === src.id}
            onAnalyze={() => runAnalyze(src.id)}
            onSelectSuggestion={addMany}
            archived={archived[src.id]}
            onLoadArchived={() => loadArchived(src.id)}
            onRestore={(blockId, name) => doRestore(src.id, blockId, name)}
          />
        ))}
      </div>
    </div>
  );
}

function SourceCard(props: {
  src: LibrarySource;
  selected: Set<string>;
  onToggle: (id: string) => void;
  analyze?: LibraryAnalyzeResult;
  analyzing: boolean;
  onAnalyze: () => void;
  onSelectSuggestion: (ids: string[]) => void;
  archived?: ArchivedRecord[];
  onLoadArchived: () => void;
  onRestore: (blockId: string, name: string) => void;
}) {
  const { src } = props;
  const [open, setOpen] = useState(src.sourceKind === "central-memory");
  const [showArchived, setShowArchived] = useState(false);

  const realBlocks = src.blocks.filter((b) => !b.flags.orphanIndex);
  const orphanIndex = src.blocks.filter((b) => b.flags.orphanIndex);

  return (
    <section className="bg-surface border border-border rounded">
      <div className="flex flex-wrap items-center gap-2 p-3 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <span className="text-xs">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-sm">{src.label}</span>
        <span className="text-[10px] text-subtle font-mono">{src.id}</span>
        <span className="text-xs text-subtle">
          {realBlocks.length} {src.kind}
          {src.kind === "memory" && src.indexLineCount != null && (
            <> · MEMORY.md {src.indexLineCount}行/{((src.indexBytes ?? 0) / 1024).toFixed(0)}KB</>
          )}
        </span>
        {src.kind === "memory" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onAnalyze();
            }}
            disabled={props.analyzing}
            className="ml-auto text-xs border border-border rounded px-2 py-1 hover:border-accent/50 disabled:opacity-50"
          >
            {props.analyzing ? "解析中…" : "矛盾/整理サジェスト"}
          </button>
        )}
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {/* サジェスト */}
          {props.analyze && (
            <div className="border border-accent/30 rounded p-2 space-y-1">
              {props.analyze.disabled ? (
                <div className="text-xs text-subtle">LLM 解析は無効化中 (CONCORDIA_DISABLE_CLAUDE=1)。</div>
              ) : props.analyze.suggestions.length === 0 ? (
                <div className="text-xs text-subtle">提案はありませんでした。</div>
              ) : (
                props.analyze.suggestions.map((s, i) => (
                  <div key={i} className="text-xs flex flex-wrap items-center gap-1.5">
                    <span className="px-1 rounded bg-accent/10 text-accent">{s.kind}</span>
                    <span>{s.message}</span>
                    <button
                      onClick={() => props.onSelectSuggestion(s.blockIds)}
                      className="text-accent hover:underline"
                    >
                      該当 {s.blockIds.length} 件を選択
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ブロック一覧 */}
          <ul className="divide-y divide-border/60">
            {realBlocks.map((b) => (
              <BlockRow
                key={b.id}
                block={b}
                checked={props.selected.has(b.id)}
                onToggle={() => props.onToggle(b.id)}
              />
            ))}
          </ul>

          {/* orphan-index (ファイル無しの index 行) */}
          {orphanIndex.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="text-[10px] text-subtle mb-1">MEMORY.md に行のみ残存 (退避=行削除):</div>
              <ul className="divide-y divide-border/60">
                {orphanIndex.map((b) => (
                  <BlockRow
                    key={b.id}
                    block={b}
                    checked={props.selected.has(b.id)}
                    onToggle={() => props.onToggle(b.id)}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* 退避台帳 */}
          <div className="border-t border-border pt-2">
            <button
              onClick={() => {
                setShowArchived((v) => !v);
                if (!showArchived) props.onLoadArchived();
              }}
              className="text-xs text-subtle hover:text-fg"
            >
              {showArchived ? "▾" : "▸"} 退避済み台帳
            </button>
            {showArchived && (
              <ul className="mt-1 space-y-0.5">
                {(props.archived ?? []).length === 0 && (
                  <li className="text-xs text-subtle">退避済みはありません。</li>
                )}
                {(props.archived ?? []).map((r) => (
                  <li key={r.blockId} className="text-xs flex items-center gap-2">
                    <span className="text-subtle font-mono">{fmtTs(r.ts)}</span>
                    <span>{r.name}</span>
                    {r.reason && <span className="text-subtle">— {r.reason}</span>}
                    <button
                      onClick={() => props.onRestore(r.blockId, r.name)}
                      className="text-accent hover:underline ml-auto"
                    >
                      復帰
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function BlockRow(props: { block: LibraryBlock; checked: boolean; onToggle: () => void }) {
  const { block: b } = props;
  return (
    <li className="py-1.5 flex items-start gap-2">
      <input type="checkbox" checked={props.checked} onChange={props.onToggle} className="mt-1" />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium truncate">{b.title}</span>
          <span className="text-[10px] text-subtle font-mono">{b.name}</span>
          {flagBadges(b)}
        </div>
        {b.description && <div className="text-xs text-subtle line-clamp-2">{b.description}</div>}
        {!b.flags.orphanIndex && (
          <div className="text-[10px] text-subtle">
            {(b.size_bytes / 1024).toFixed(1)}KB · {b.line_count}行 · {fmtTs(b.mtime)}
          </div>
        )}
      </div>
    </li>
  );
}

function flagBadges(b: LibraryBlock) {
  const badges: Array<{ t: string; cls: string }> = [];
  if (b.flags.orphanIndex) badges.push({ t: "orphan-index", cls: "text-warn" });
  if (b.flags.orphanFile) badges.push({ t: "no-index", cls: "text-warn" });
  if (b.flags.duplicateName) badges.push({ t: "dup", cls: "text-danger" });
  if (b.flags.oversize) badges.push({ t: "大", cls: "text-warn" });
  if (b.flags.stale) badges.push({ t: "陳腐化?", cls: "text-subtle" });
  if (b.flags.poison && b.flags.poison.length) badges.push({ t: "注意", cls: "text-danger" });
  return badges.map((x, i) => (
    <span key={i} className={`text-[10px] px-1 rounded border border-current/30 ${x.cls}`}>
      {x.t}
    </span>
  ));
}
