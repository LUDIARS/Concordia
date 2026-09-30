// @implements SPEC-DLG-CORRECTIONS
import { useEffect, useState } from "react";

import { api, type SubsidiarySummary, type UseCaseCorrection } from "../../api.js";

// 1 ユースケースの「人の訂正」の管理 (spec/feature/dialogue-context.md §6)。 訂正は会社ごとに
// 分けて以後の起動へ渡すため、 追加時に会社を選ぶ。 無効化した訂正は起動に渡らない。

export function UseCasesCorrections({ useCaseId, subsidiaries }: { useCaseId: string; subsidiaries: SubsidiarySummary[] }) {
  const [corrections, setCorrections] = useState<UseCaseCorrection[]>([]);
  const [question, setQuestion] = useState("");
  const [correction, setCorrection] = useState("");
  const [organization, setOrganization] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setCorrections((await api.useCaseCorrections(useCaseId)).corrections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [useCaseId]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const organizationName = (subsidiaryId: string | null) => subsidiaryId === null
    ? "本社"
    : subsidiaries.find((s) => s.id === subsidiaryId)?.display_name || subsidiaryId;

  return (
    <div className="space-y-2">
      <div className="text-xs text-subtle">
        これまでの訂正 (新しい順)。同じ会社の有効な訂正だけが、最大 30 件・6,000 文字まで起動時に渡ります。
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      {corrections.length === 0 && <div className="text-subtle text-xs">訂正はまだありません。</div>}
      {corrections.map((row) => (
        <div key={row.id} className={`border border-border rounded p-2 text-xs space-y-1 ${row.active ? "" : "opacity-60"}`}>
          <div className="flex items-center gap-2 text-subtle">
            <span>{organizationName(row.subsidiary_id)}</span>
            <span>{row.source}</span>
            <span>{new Date(row.created_at).toLocaleString()}</span>
            <button type="button" className="ml-auto text-accent"
              onClick={() => void run(() => api.useCaseCorrectionUpdate(useCaseId, row.id, { active: row.active !== 1 }))}>
              {row.active ? "無効化" : "有効化"}
            </button>
            <button type="button" className="text-danger"
              onClick={() => void run(() => api.useCaseCorrectionDelete(useCaseId, row.id))}>
              削除
            </button>
          </div>
          {row.question && <div><span className="text-subtle">問:</span> {row.question}</div>}
          <div><span className="text-subtle">訂正:</span> {row.correction}</div>
        </div>
      ))}
      <div className="grid gap-2 md:grid-cols-[auto_minmax(0,1fr)]">
        <select className="foundation-form text-xs" value={organization} onChange={(e) => setOrganization(e.target.value)}>
          <option value="">本社</option>
          {subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.name}</option>)}
        </select>
        <input className="foundation-form text-xs" placeholder="何についての訂正か (任意)" value={question} onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <textarea className="foundation-form w-full text-xs min-h-[60px]" placeholder="正しい内容" value={correction}
        onChange={(e) => setCorrection(e.target.value)} />
      <button
        type="button"
        className="px-3 py-1 rounded bg-accent text-white text-xs disabled:opacity-50"
        disabled={!correction.trim()}
        onClick={() => void run(async () => {
          await api.useCaseCorrectionCreate(useCaseId, {
            correction: correction.trim(), question: question.trim(), subsidiary_id: organization || null,
          });
          setCorrection("");
          setQuestion("");
        })}
      >
        訂正を追加
      </button>
    </div>
  );
}
