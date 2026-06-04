import { useEffect, useState } from "react";
import { api, type ModelCatalogItem, type ModelCatalogProvider } from "../api.js";

// delegation テンプレ / spawn が選べるモデル候補を手動管理するセクション。
// 設定ページ (Settings) の 1 セクションとして埋め込む。 ここで足したモデルが
// Delegation テンプレ編集の model プルダウンに出る。

const PROVIDERS: ModelCatalogProvider[] = ["any", "claude", "codex", "gemini"];

interface DraftState {
  model_id: string;
  label: string;
  provider: ModelCatalogProvider;
  sort_order: string;
}

const EMPTY_DRAFT: DraftState = { model_id: "", label: "", provider: "any", sort_order: "0" };

export function ModelCatalogSection() {
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const m = await api.modelCatalogList(true); // inactive も含めて管理表示
      setModels(m.models);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add() {
    if (!draft.model_id.trim()) {
      setError("model_id は必須です");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.modelCatalogCreate({
        model_id: draft.model_id.trim(),
        label: draft.label.trim() || undefined,
        provider: draft.provider,
        sort_order: Number(draft.sort_order) || 0,
      });
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(m: ModelCatalogItem) {
    setBusy(true);
    try {
      await api.modelCatalogUpdate(m.id, { is_active: !m.is_active });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: ModelCatalogItem) {
    if (!confirm(`モデル ${m.model_id} を削除しますか?`)) return;
    setBusy(true);
    try {
      await api.modelCatalogDelete(m.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">モデルカタログ</h2>
        <p className="text-subtle text-sm mt-1">
          Delegation テンプレ / spawn の <code>--model</code> で選べるモデル候補。
          新モデル登場 / 旧モデル廃止に合わせてここで手動更新します。
          provider が <code>any</code> のものは全 provider のプルダウンに出ます。
        </p>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <table className="w-full text-sm">
        <thead className="text-xs text-subtle">
          <tr>
            <th className="text-left p-2">provider</th>
            <th className="text-left p-2">model_id</th>
            <th className="text-left p-2">label</th>
            <th className="text-left p-2">order</th>
            <th className="text-left p-2">active</th>
            <th className="text-right p-2">actions</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id} className="border-t border-border">
              <td className="p-2"><code>{m.provider}</code></td>
              <td className="p-2 font-mono text-xs">{m.model_id}</td>
              <td className="p-2">{m.label || <span className="text-subtle">—</span>}</td>
              <td className="p-2 text-xs">{m.sort_order}</td>
              <td className="p-2">{m.is_active ? "✓" : "—"}</td>
              <td className="p-2 text-right space-x-2">
                <button className="text-xs" disabled={busy} onClick={() => toggleActive(m)}>
                  {m.is_active ? "無効化" : "有効化"}
                </button>
                <button className="text-danger text-xs" disabled={busy} onClick={() => remove(m)}>
                  削除
                </button>
              </td>
            </tr>
          ))}
          {models.length === 0 && (
            <tr>
              <td colSpan={6} className="p-2 text-subtle text-xs">
                モデル候補がありません。 下のフォームから追加してください。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="border-t border-border pt-3 grid grid-cols-2 gap-2">
        <label className="text-sm space-y-1">
          <span className="text-subtle">provider</span>
          <select
            className="foundation-form w-full"
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value as ModelCatalogProvider })}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="text-sm space-y-1">
          <span className="text-subtle">sort_order</span>
          <input
            className="foundation-form w-full"
            type="number"
            value={draft.sort_order}
            onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-subtle">model_id (--model に渡す実値)</span>
          <input
            className="foundation-form w-full"
            placeholder="例: claude-opus-4-8 / gpt-5.5"
            value={draft.model_id}
            onChange={(e) => setDraft({ ...draft, model_id: e.target.value })}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-subtle">label (表示名、 任意)</span>
          <input
            className="foundation-form w-full"
            placeholder="例: Opus 4.8"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <div className="col-span-2">
          <button
            onClick={add}
            disabled={busy}
            className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            + モデルを追加
          </button>
        </div>
      </div>
    </div>
  );
}
