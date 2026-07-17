import { useEffect, useState } from "react";
import { api, type InjectManual } from "../api.js";

// kind 別 Inject マニュアルの調整ページ。 delegation invoke の協調コンテキスト冒頭へ
// 「## 作業マニュアル (kind: …)」として差し込まれる内容を kind ごとに編集する。
// kind 語彙は固定 (設計相談 | 実装 | レビュー | テスト | 雑用)。 追加・削除は不可。

function formatUpdatedAt(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function Manuals() {
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
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold">Inject マニュアル</h1>
        <p className="text-subtle text-sm mt-1">
          Delegation で spawn するセッションの協調コンテキストへ、 作業 kind 別に差し込む
          「作業マニュアル」を調整します (例: レビューや設計では worktree 生成・ブランチ切替を
          不要にする)。 kind はテンプレの call_name / title から自動判定されます
          (impl / fix / refactor → 実装 を最優先、 次に review → レビュー /
          design → 設計相談 / test → テスト / それ以外 → 実装)。
        </p>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      {manuals.map((m) => {
        const draft = drafts[m.kind] ?? "";
        const dirty = draft !== m.content;
        return (
          <section key={m.kind} className="border border-border rounded p-3 space-y-2 bg-surface">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{m.kind}</h2>
              <span className="text-subtle text-xs">更新: {formatUpdatedAt(m.updated_at)}</span>
            </div>
            <textarea
              className="foundation-form w-full h-32 text-sm"
              value={draft}
              onChange={(e) => setDrafts({ ...drafts, [m.kind]: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => save(m.kind)}
                disabled={busyKind === m.kind || !dirty}
                className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
              >
                保存
              </button>
              {dirty && <span className="text-subtle text-xs">未保存の変更があります</span>}
              {savedKind === m.kind && !dirty && <span className="text-subtle text-xs">保存しました</span>}
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
