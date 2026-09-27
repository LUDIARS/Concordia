// @spec CC-TOOLS-WEB-01: WebUI の確認画面
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface ToolEntry {
  mcp: string;
  http: string;
  operation?: string;
  owner?: string;
  preparation?: string;
  effect?: string;
  transport?: string;
}
interface Catalog { location: string; tools: ToolEntry[]; existing: ToolEntry[] }

/** @implements CC-TOOLS-WEB-01 — capability browsing never invokes an operation. */
export function DeveloperTools() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetch("/v1/developer-tools/catalog", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`ツール一覧を取得できません (${response.status})`);
        const data = await response.json() as Catalog;
        if (!Array.isArray(data.tools) || !Array.isArray(data.existing)) throw new Error("ツール一覧の形式が不正です");
        if (!controller.signal.aborted) setCatalog(data);
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "取得に失敗しました");
      });
    return () => controller.abort();
  }, [revision]);
  const needle = query.trim().toLowerCase();
  const tools = [...catalog?.tools ?? [], ...catalog?.existing ?? []]
    .filter(tool => [tool.mcp, tool.operation, tool.owner, tool.preparation].join(" ").toLowerCase().includes(needle));
  return <div className="space-y-4">
    <header><h1 className="text-xl font-semibold">開発ツール</h1>
      <p className="mt-1 text-sm text-subtle">共通ツールの入口と利用に必要な準備を確認できます。掲載は接続・動作確認済みを意味しません。</p>
    </header>
    <div className="flex flex-wrap items-center gap-3">
      <input aria-label="ツールを検索" value={query} onChange={event => setQuery(event.target.value)} placeholder="名前・提供元・準備条件で検索" className="min-w-0 rounded border border-border bg-surface p-2" />
      <button type="button" onClick={() => setRevision(value => value + 1)} className="rounded border border-border px-3 py-2">再読込</button>
      <Link to="/settings" className="text-accent">RWF・ローカルスキルの設定</Link>
    </div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!catalog && !error && <p role="status">読み込み中…</p>}
    {catalog && <>
      <p className="text-sm text-subtle">有効箇所: {catalog.location}。MCP はクライアントごとの接続が必要です。HTTP 入口も利用できます。</p>
      <p className="text-sm">{tools.length} 件{error ? "（前回取得した一覧）" : ""}</p>
      {tools.length === 0 && <p>該当するツールはありません。</p>}
      <div className="grid gap-3 lg:grid-cols-2">{tools.map(tool => <article key={tool.mcp} className="min-w-0 rounded border border-border bg-surface p-4">
        <h2 className="break-all font-mono text-sm text-accent">{tool.mcp}</h2>
        <dl className="mt-2 space-y-2 text-sm">
          <div><dt className="text-subtle">HTTP 入口</dt><dd className="break-all font-mono">{tool.http}</dd></div>
          {tool.owner && <div><dt className="text-subtle">提供元</dt><dd>{tool.owner} / {tool.transport}</dd></div>}
          {tool.preparation && <div><dt className="text-subtle">必要な準備</dt><dd>{tool.preparation}</dd></div>}
          {tool.effect && <div><dt className="text-subtle">操作の種類</dt><dd>{tool.effect}</dd></div>}
        </dl>
      </article>)}</div>
    </>}
  </div>;
}
