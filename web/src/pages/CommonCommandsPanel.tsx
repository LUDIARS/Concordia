// @spec Read-only command and script catalog
// @implements CC-COMMAND-CATALOG-01: searchable read-only common command view.
import { useEffect, useState } from "react";

interface Command { name: string; usage: string; description: string }

export function CommonCommandsPanel({ query }: { query: string }) {
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCommands(null);
    setError(null);
    void fetch("/v1/developer-tools/commands", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`共通コマンドを取得できません (${response.status})`);
      const data = await response.json() as { commands?: Command[] };
      if (!Array.isArray(data.commands)) throw new Error("共通コマンド一覧の形式が不正です");
      if (!controller.signal.aborted) setCommands(data.commands);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "取得に失敗しました");
    });
    return () => controller.abort();
  }, [revision]);
  const needle = query.trim().toLowerCase();
  const shown = commands?.filter(command => [command.name, command.usage, command.description]
    .join(" ").toLowerCase().includes(needle)) ?? [];
  return <section className="space-y-3">
    <p className="text-sm text-subtle">command-runner の現在の定義です。共通コマンドの権限ラベルは一覧元に宣言されていません。実行時の権限判定は各操作とハーネスが行います。</p>
    <button type="button" onClick={() => setRevision(value => value + 1)} className="rounded border border-border px-3 py-2">再読込</button>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!commands && !error && <p role="status">読み込み中…</p>}
    {commands && <>
      <p className="text-sm">{shown.length} 件</p>
      {shown.length === 0 && <p>該当するコマンドはありません。</p>}
      <div className="grid gap-3 lg:grid-cols-2">{shown.map(command => <article key={command.name} className="min-w-0 rounded border border-border bg-surface p-4">
        <h2 className="font-mono text-sm text-accent">{command.name}</h2>
        <p className="mt-2 text-sm">{command.description}</p>
        <p className="mt-2 break-all font-mono text-xs text-subtle">{command.usage}</p>
      </article>)}</div>
    </>}
  </section>;
}
