import { useEffect, useState } from "react";
import { fmtSec, rulesApi, type KnowledgeSourceKind, type KnowledgeSourceView } from "./rules-api.js";

// 巡回チャットの知識の取り込み状態 (spec/feature/patrol-chat.md「知識」)。 種類ごとの件数・最終取得・失敗理由と、
// 手動の取り直し。 取り直しは裏で回るので、 少し待ってから状態を読み直す。 トークンなどの秘密値は出さない (API も返さない)。

const KIND_LABEL: Record<KnowledgeSourceKind, string> = {
  ludiars: "LUDIARS 内部 (一覧・README・spec)",
  revisor: "直近 7 日のマージ",
  notion: "Notion",
};

const RELOAD_AFTER_MS = 3000;

function summarize(counts: KnowledgeSourceView["counts"]): string {
  if (counts.length === 0) return "0 件";
  const by = (scope: "hq" | "public") => counts.filter((c) => c.scope === scope).reduce((n, c) => n + c.chunks, 0);
  const docs = counts.reduce((n, c) => n + c.docs, 0);
  return `${docs} 文書 · 断片 本社限定 ${by("hq")} / 公開 ${by("public")}`;
}

export function KnowledgePanel() {
  const [sources, setSources] = useState<KnowledgeSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await rulesApi.knowledge();
    if (res.ok) { setSources(res.data.sources); setError(null); }
    else setError(res.error);
  };

  useEffect(() => { void load(); }, []);

  const refresh = async (kind?: KnowledgeSourceKind) => {
    const res = await rulesApi.refreshKnowledge(kind ? [kind] : undefined);
    if (!res.ok) { setError(res.error); return; }
    setSources(res.data.sources);
    setTimeout(() => void load(), RELOAD_AFTER_MS);
  };

  // 知識が配線されていない (503) / 読めない環境ではパネルを出さない
  if (sources === null) return null;
  return (
    <section className="border border-border rounded px-3 py-2 space-y-1 text-sm" data-testid="knowledge-panel">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-subtle">知識</span>
        <button type="button" className="px-2 py-0.5 rounded border border-border text-xs" onClick={() => void refresh()}>すべて取り直す</button>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      <ul className="space-y-1">
        {(sources ?? []).map((s) => (
          <li key={s.kind} data-testid={`knowledge-${s.kind}`} className="text-xs">
            <span className="font-medium">{KIND_LABEL[s.kind]}</span>
            {" · "}{summarize(s.counts)}
            {" · "}最終取得 {fmtSec(s.last_success_at)}
            {s.running && " · 取り込み中"}
            {!s.configured && " · 未設定"}
            {s.last_error && <span className="text-red-600"> · {s.last_error}</span>}
            {" "}
            <button type="button" className="underline" onClick={() => void refresh(s.kind)}>取り直す</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
