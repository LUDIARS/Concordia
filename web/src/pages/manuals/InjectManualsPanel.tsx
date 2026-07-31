import { useEffect, useState } from "react";

import { api, type InjectManual } from "../../api.js";

// kind 別 Inject マニュアルの調整パネル。 delegation invoke の協調コンテキスト冒頭へ
// 「## 作業マニュアル (kind: …)」として差し込まれる内容を kind ごとに編集する。
// kind 語彙は固定 (設計相談 | 実装 | レビュー | テスト | 雑用)。 追加・削除は不可。

/** kind ごとの「いつ差し込まれるか」の説明 (判定は backend の call_name / title 由来)。 */
const KIND_HINT: Record<string, string> = {
  実装: "call_name / title に impl / fix / refactor を含むとき (既定の落とし先でもある)",
  レビュー: "call_name / title に review を含むとき",
  設計相談: "call_name / title に design を含むとき",
  テスト: "call_name / title に test を含むとき",
  雑用: "上記に当てはまらない雑務系テンプレを明示的に割り当てたとき",
};

function formatUpdatedAt(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function InjectManualsPanel() {
  const [manuals, setManuals] = useState<InjectManual[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [savedKind, setSavedKind] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api.injectManualsList();
      setManuals(r.manuals);
      setDrafts(Object.fromEntries(r.manuals.map((m) => [m.kind, m.content])));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(kind: string) {
    setBusyKind(kind);
    setError(null);
    try {
      const r = await api.injectManualUpdate(kind, drafts[kind] ?? "");
      setManuals((prev) => prev.map((m) => (m.kind === kind ? r.manual : m)));
      setSavedKind(kind);
      setTimeout(() => setSavedKind((cur) => (cur === kind ? null : cur)), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-subtle text-sm">
        Delegation で spawn するセッションの協調コンテキストへ、 作業 kind 別に差し込む
        「作業マニュアル」を調整します (例: レビューや設計では worktree 生成・ブランチ切替を
        不要にする)。 kind はテンプレの call_name / title から自動判定され、 語彙は固定です。
      </p>

      {error && <div className="text-danger text-sm">{error}</div>}

      {manuals.map((m) => {
        const draft = drafts[m.kind] ?? "";
        const dirty = draft !== m.content;
        return (
          <section key={m.kind} className="border border-border rounded p-3 space-y-2 bg-surface">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="font-semibold text-sm">{m.kind}</h3>
              <span className="text-subtle text-xs">更新: {formatUpdatedAt(m.updated_at)}</span>
            </div>
            {KIND_HINT[m.kind] && (
              <div className="text-[11px] text-subtle">差し込み条件: {KIND_HINT[m.kind]}</div>
            )}
            <textarea
              className="foundation-form w-full h-32 text-sm"
              value={draft}
              disabled={busyKind === m.kind}
              onChange={(e) => setDrafts({ ...drafts, [m.kind]: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save(m.kind)}
                disabled={busyKind === m.kind || !dirty}
                className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
              >
                保存
              </button>
              {dirty && <span className="text-subtle text-xs">未保存の変更があります</span>}
              {savedKind === m.kind && !dirty && (
                <span className="text-subtle text-xs">保存しました</span>
              )}
            </div>
          </section>
        );
      })}

      {manuals.length === 0 && !error && (
        <div className="text-subtle text-sm">
          マニュアルがまだありません。 Concordia backend の起動時に既定内容が seed されます。
        </div>
      )}
    </div>
  );
}
