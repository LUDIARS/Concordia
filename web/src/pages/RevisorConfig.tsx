import { useEffect, useState } from "react";
import { api, type RevisorConfigStatus } from "../api.js";

// Revisor の workflow token をサービス内 (この画面) から設定する。
// token は DB に暗号化保存され、値そのものは二度と返らない (set 済みと出所だけ表示)。
// Revisor は loopback でも GET 以外 (local PR 提出 / merge / retry / リポ登録) に token を
// 要求するので、これが未設定だと Cc から local PR を扱えない。
// 設定ページ (Settings) の 1 セクションとして埋め込む。
// @implements spec/feature/revisor-local-pr-submission.md — 6. token

export function RevisorSettingsSection() {
  const [status, setStatus] = useState<RevisorConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setToken] = useState("");

  async function refresh() {
    try {
      setStatus(await api.revisorConfigGet());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(next: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await api.revisorConfigSet({ workflow_token: next }));
      setToken("");
      setMsg(next === null ? "クリアしました (env フォールバックに戻ります)" : "保存しました");
    } catch (e) {
      setMsg(`保存失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel = status?.source === "db"
    ? "この画面で設定した値 (DB / 暗号化)"
    : status?.source === "env"
      ? "env CONCORDIA_REVISOR_WORKFLOW_TOKEN"
      : "未設定";

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">Revisor</h2>
        <p className="text-subtle text-sm mt-1">
          local PR の提出・マージ・再審査に使う workflow token。Revisor 側の
          <code className="mx-1">revisor.config.json</code>
          に入っている値と同じものを入れる。保存は次のリクエストから効く (再起動不要)。
        </p>
      </div>

      {error && <div className="text-danger text-sm">読み込み失敗: {error}</div>}

      <div className="text-sm">
        状態: {status?.workflow_token_set ? "設定済み" : "未設定"}
        <span className="text-subtle"> / 出所: {sourceLabel}</span>
      </div>

      <label className="block text-sm">
        workflow token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="空欄は据え置き"
          className="mt-1 w-full bg-surface border border-border rounded px-2 py-1"
        />
      </label>

      <div className="flex gap-2">
        <button
          disabled={busy || token.trim() === ""}
          onClick={() => void save(token.trim())}
          className="px-3 py-1 rounded border border-accent text-accent disabled:opacity-40"
        >
          保存
        </button>
        <button
          disabled={busy || status?.source !== "db"}
          onClick={() => void save(null)}
          className="px-3 py-1 rounded border border-border disabled:opacity-40"
        >
          クリア
        </button>
      </div>

      {msg && <div className="text-sm text-subtle">{msg}</div>}
    </div>
  );
}
