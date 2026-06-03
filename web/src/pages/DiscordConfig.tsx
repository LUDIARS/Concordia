import { useEffect, useState } from "react";
import { api, type DiscordConfigStatus, type SlackBotActionResult } from "../api.js";

// Discord 連携をサービス内 (この画面) から設定する (Slack 設定と対の構成)。
// token は送信後 DB に暗号化保存され、 値そのものは二度と返らない (set 済みかだけ表示)。
// 保存すると bot を hot 再接続する。 設定ページ (Settings) の 1 セクションとして埋め込む。

export function DiscordSettingsSection() {
  const [status, setStatus] = useState<DiscordConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // フォーム入力 (token は空 = 据え置き)。
  const [enabled, setEnabled] = useState(false);
  const [guildId, setGuildId] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [token, setToken] = useState("");

  async function refresh() {
    try {
      const s = await api.discordConfigGet();
      setStatus(s);
      setEnabled(s.enabled);
      setGuildId(s.guild_id ?? "");
      setApplicationId(s.application_id ?? "");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.discordConfigSet({
        enabled,
        guild_id: guildId.trim() === "" ? null : guildId.trim(),
        application_id: applicationId.trim() === "" ? null : applicationId.trim(),
        // 空欄は undefined にして据え置き (token を消したい時はクリアボタンを使う)。
        token: token.trim() === "" ? undefined : token.trim(),
      });
      setStatus(r.status);
      setToken("");
      setMsg(`保存 + 再接続: ${r.restart.status}${r.restart.error ? ` (${r.restart.error})` : ""}`);
    } catch (e) {
      setMsg(`保存失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function lifecycle(action: () => Promise<SlackBotActionResult>, label: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await action();
      setMsg(`${label}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
      await refresh();
    } catch (e) {
      setMsg(`${label} 失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const tokenBadge = (set: boolean, source: string) =>
    set ? (
      <span className="text-xs px-1.5 py-0.5 rounded bg-ok/20 text-ok">設定済 ({source})</span>
    ) : (
      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-subtle">未設定</span>
    );

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Discord 連携</h2>
        <p className="text-subtle text-sm mt-1">
          token / guild / application をこの画面から設定します. 保存すると即 bot を再接続するので
          サービス再起動は不要です. token は暗号化して保存され、 値は二度と表示されません
          (env <code>CONCORDIA_DISCORD_*</code> はフォールバックとして残ります).
        </p>
      </header>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {status && (
        <section className="bg-surface border border-border rounded p-4 text-sm space-y-2">
          <h2 className="font-semibold">現在の状態</h2>
          <div className="flex items-center gap-2">
            <span className="text-subtle text-xs w-28">enabled</span>
            <span className={status.enabled ? "text-ok" : "text-subtle"}>
              {status.enabled ? "ON" : "OFF"} ({status.source.enabled})
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-subtle text-xs w-28">guild_id</span>
            <span className="font-mono text-xs">{status.guild_id ?? "(未設定)"}</span>
            <span className="text-subtle text-[11px]">({status.source.guild_id})</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-subtle text-xs w-28">application_id</span>
            <span className="font-mono text-xs">{status.application_id ?? "(未設定)"}</span>
            <span className="text-subtle text-[11px]">({status.source.application_id})</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-subtle text-xs w-28">bot token</span>
            {tokenBadge(status.token_set, status.source.token)}
          </div>
        </section>
      )}

      <section className="bg-surface border border-border rounded p-4 text-sm space-y-3">
        <h2 className="font-semibold">設定</h2>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Discord 連携を有効化 (enabled)</span>
        </label>

        <div>
          <div className="text-subtle text-xs mb-1">Guild (Server) ID</div>
          <input
            type="text"
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            placeholder="123456789012345678"
            className="w-full bg-muted border border-border rounded px-2 py-1 text-xs font-mono"
          />
        </div>

        <div>
          <div className="text-subtle text-xs mb-1">
            Application ID <span className="text-[11px]">slash command 登録に使用</span>
          </div>
          <input
            type="text"
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            placeholder="123456789012345678"
            className="w-full bg-muted border border-border rounded px-2 py-1 text-xs font-mono"
          />
        </div>

        <div>
          <div className="text-subtle text-xs mb-1">
            Bot Token <span className="text-[11px]">空欄=据え置き</span>
          </div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={status?.token_set ? "設定済 (変更する時だけ入力)" : "Bot Token"}
            autoComplete="off"
            className="w-full bg-muted border border-border rounded px-2 py-1 text-xs font-mono"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={save}
            disabled={busy}
            className="px-3 py-1 rounded border border-accent bg-accent/20 text-accent text-xs disabled:opacity-50"
          >
            保存して再接続
          </button>
          <button
            onClick={() => lifecycle(api.discordBotRestart, "restart")}
            disabled={busy}
            className="px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
          >
            Restart
          </button>
          <button
            onClick={() => lifecycle(api.discordBotStop, "stop")}
            disabled={busy}
            className="px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
          >
            Stop
          </button>
          <button
            onClick={() => lifecycle(api.discordBotStart, "start")}
            disabled={busy}
            className="px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
          >
            Start
          </button>
        </div>
        {msg && <div className="text-xs text-subtle">{msg}</div>}
      </section>

      <section className="bg-surface border border-border rounded p-4 text-xs text-subtle space-y-1">
        <h2 className="font-semibold text-text mb-1">補足</h2>
        <p>
          token クリア (env に戻す) は API で空文字を送ると行えます。 Bot の作成と Privileged
          Intents の有効化は <code>spec/setup/discord.md</code> を参照してください。
        </p>
      </section>
    </div>
  );
}
