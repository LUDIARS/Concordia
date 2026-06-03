import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type SlackBotActionResult } from "../api.js";
import { SlackSettingsSection } from "./SlackConfig.js";

// Concordia の「設定」ページ。サービス内で変更できる連携設定をここに集約する。
// 現状: Slack 連携 (DB+暗号化) / Discord bot ライフサイクル。
// ランタイム kill switch (chat-mute / rules-enabled / proposer 間隔) は Rules ページ。

export function Settings() {
  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">設定</h1>
        <p className="text-subtle text-sm mt-1">
          サービス内で変更できる連携設定. 変更は保存した時点で反映されます (再起動不要).
        </p>
      </header>

      <section className="border border-border rounded p-4">
        <SlackSettingsSection />
      </section>

      <section className="border border-border rounded p-4">
        <DiscordSettingsSection />
      </section>

      <section className="bg-surface border border-border rounded p-4 text-xs text-subtle">
        <h2 className="font-semibold text-text mb-1">その他の設定</h2>
        <p>
          ランタイムの kill switch (チャット mute / ルール有効化 / proposer 間隔) は
          <Link to="/rules" className="text-accent"> Rules</Link> ページにあります.
          skill / hook の導入は <Link to="/setup" className="text-accent">Setup</Link> ページ.
        </p>
      </section>
    </div>
  );
}

// Discord bot の起動・停止・再起動。token/guild は env 由来 (spec/setup/discord.md)。
function DiscordSettingsSection() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(action: () => Promise<SlackBotActionResult>, label: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await action();
      setMsg(`${label}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    } catch (e) {
      setMsg(`${label} 失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const btn =
    "px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50";

  return (
    <div className="space-y-3">
      <header>
        <h2 className="text-lg font-semibold">Discord bot</h2>
        <p className="text-subtle text-sm mt-1">
          token / guild は env (<code>CONCORDIA_DISCORD_*</code>) 由来. ここでは bot の
          起動 / 停止 / 再起動だけ操作できます (channel は起動時に自動検出).
        </p>
      </header>
      <div className="flex gap-2">
        <button onClick={() => run(api.discordBotRestart, "restart")} disabled={busy} className={btn}>
          Restart
        </button>
        <button onClick={() => run(api.discordBotStop, "stop")} disabled={busy} className={btn}>
          Stop
        </button>
        <button onClick={() => run(api.discordBotStart, "start")} disabled={busy} className={btn}>
          Start
        </button>
      </div>
      {msg && <div className="text-xs text-subtle">{msg}</div>}
    </div>
  );
}
