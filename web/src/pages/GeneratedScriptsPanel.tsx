// @spec Read-only command and script catalog
// @implements CC-COMMAND-CATALOG-01: registered-project script manifest view.
import { useEffect, useState } from "react";

interface Project { code: string; project: string }
interface Script {
  id: string;
  description: string;
  arguments: Array<{ name: string; required: boolean }>;
  requiredPermissions: string[];
  digest: string;
  verified: boolean;
}

export function GeneratedScriptsPanel({ query }: { query: string }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<{ code: string; scripts: Script[] } | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProjects(null);
    setProjectError(null);
    setResult(null);
    setScriptError(null);
    void fetch("/v1/developer-tools/scripts/projects", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`登録リポジトリを取得できません (${response.status})`);
      const data = await response.json() as { projects?: Project[] };
      if (!Array.isArray(data.projects)) throw new Error("登録リポジトリ一覧の形式が不正です");
      if (controller.signal.aborted) return;
      setProjects(data.projects);
      setCode(previous => data.projects?.some(project => project.code === previous) ? previous : data.projects?.[0]?.code ?? "");
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setProjectError(reason instanceof Error ? reason.message : "取得に失敗しました");
    });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!code || !projects?.some(project => project.code === code)) return;
    const controller = new AbortController();
    setScriptError(null);
    setResult(null);
    void fetch(`/v1/developer-tools/scripts?code=${encodeURIComponent(code)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`生成スクリプトを取得できません (${response.status})`);
      const data = await response.json() as { code?: string; scripts?: Script[] };
      if (data.code !== code || !Array.isArray(data.scripts)) throw new Error("生成スクリプト一覧の形式が不正です");
      if (!controller.signal.aborted) setResult({ code, scripts: data.scripts });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setScriptError(reason instanceof Error ? reason.message : "取得に失敗しました");
    });
    return () => controller.abort();
  }, [code, projects, revision]);
  const current = projects?.some(project => project.code === code) && result?.code === code && !projectError && !scriptError
    ? result.scripts : null;
  const needle = query.trim().toLowerCase();
  const shown = current?.filter(script => [script.id, script.description, ...script.requiredPermissions,
    ...script.arguments.map(argument => argument.name)].join(" ").toLowerCase().includes(needle)) ?? [];
  return <section className="space-y-3">
    <p className="text-sm text-subtle">生成スクリプトの宣言と現行内容の検証状態です。検証済みでも実行許可を意味しません。</p>
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="script-project">リポジトリ</label>
      <select id="script-project" value={code} onChange={event => { setResult(null); setScriptError(null); setCode(event.target.value); }} disabled={!projects?.length} className="rounded border border-border bg-surface p-2">
        {projects?.map(project => <option key={project.code} value={project.code}>{project.project} ({project.code})</option>)}
      </select>
      <button type="button" onClick={() => setRevision(value => value + 1)} className="rounded border border-border px-3 py-2">再読込</button>
    </div>
    {projectError && <p role="alert" className="text-danger">{projectError}</p>}
    {!projects && !projectError && <p role="status">登録リポジトリを読み込み中…</p>}
    {projects?.length === 0 && <p>登録リポジトリがありません。</p>}
    {scriptError && <p role="alert" className="text-danger">{scriptError}</p>}
    {projects?.length && !current && !scriptError ? <p role="status">生成スクリプトを読み込み中…</p> : null}
    {current && <>
      <p className="text-sm">{shown.length} 件</p>
      {shown.length === 0 && <p>該当する生成スクリプトはありません。</p>}
      <div className="grid gap-3 lg:grid-cols-2">{shown.map(script => <article key={script.id} className="min-w-0 rounded border border-border bg-surface p-4">
        <h2 className="font-mono text-sm text-accent">{script.id}</h2>
        <p className="mt-2 text-sm">{script.description}</p>
        <dl className="mt-2 space-y-2 text-sm">
          <div><dt className="text-subtle">引数</dt><dd>{script.arguments.length ? script.arguments.map(argument => `${argument.name}${argument.required ? " (必須)" : " (任意)"}`).join(", ") : "なし"}</dd></div>
          <div><dt className="text-subtle">必要な権限ラベル</dt><dd>{script.requiredPermissions.join(", ")}</dd></div>
          <div><dt className="text-subtle">検証状態</dt><dd>{script.verified ? "現行内容を検証済み" : "現行内容は未検証"}</dd></div>
        </dl>
      </article>)}</div>
    </>}
  </section>;
}
