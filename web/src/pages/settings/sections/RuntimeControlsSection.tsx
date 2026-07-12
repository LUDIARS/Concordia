// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";

import { ToggleRow, putJson } from "./common.js";

// ─── ランタイム制御 (旧 Rules / AdminTogglesPanel) ───────────────────────

export function RuntimeControlsSection() {
  const [chatMuted, setChatMuted] = useState<boolean | null>(null);
  const [rulesEnabled, setRulesEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discordMsg, setDiscordMsg] = useState<string | null>(null);

  useEffect(() => { void refreshAll(); }, []);

  async function refreshAll() {
    try {
      const r = await fetch("/v1/admin/state");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = (await r.json()) as {
        chat_muted: boolean; rules_enabled: boolean;
      };
      setChatMuted(s.chat_muted);
      setRulesEnabled(s.rules_enabled);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function put(path: string, body: unknown, key: string) {
    setBusy(key); setError(null);
    try { await putJson(path, body); await refreshAll(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">runtime kill switches</h2>
        <p className="text-subtle text-xs mt-0.5">
          dispatcher / rule engine の停止スイッチ. 即時反映 + 再起動後も維持.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleRow
          label="チャット禁止 (chat-mute)"
          hint="ON で chitchat / chat-reply / session-end report などを enqueue しない. デフォルト ON."
          value={chatMuted}
          onToggle={(v) => put("/v1/admin/chat-mute", { muted: v }, "chat-mute")}
          busy={busy === "chat-mute"}
          onLabel="禁止中" offLabel="稼働中" onAction="稼働させる" offAction="禁止する"
        />
        <ToggleRow
          label="チャットルール停止 (rules-enabled)"
          hint="OFF で rule engine の発火を skip. デフォルト OFF (=停止)."
          value={rulesEnabled === null ? null : !rulesEnabled}
          onToggle={(v) => put("/v1/admin/rules-enabled", { enabled: !v }, "rules-enabled")}
          busy={busy === "rules-enabled"}
          onLabel="禁止中" offLabel="稼働中" onAction="稼働させる" offAction="禁止する"
        />
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">Discord Bot</div>
        <div className="text-xs text-subtle">Discord bot のみ再起動/起動/停止します（Concordia本体は再起動しません）。</div>
        <div className="flex items-center gap-2">
          <button
            disabled={busy === "discord-start"}
            onClick={async () => {
              setBusy("discord-start"); setDiscordMsg(null);
              try { const r = await api.discordBotStart(); setDiscordMsg(`start: ${r.status}`); }
              catch (e) { setDiscordMsg(`start failed: ${(e as Error).message}`); } finally { setBusy(null); }
            }}
            className="px-2 py-1 rounded text-xs border bg-accent/15 border-accent text-accent disabled:opacity-40"
          >start</button>
          <button
            disabled={busy === "discord-stop"}
            onClick={async () => {
              setBusy("discord-stop"); setDiscordMsg(null);
              try { const r = await api.discordBotStop(); setDiscordMsg(`stop: ${r.status}`); }
              catch (e) { setDiscordMsg(`stop failed: ${(e as Error).message}`); } finally { setBusy(null); }
            }}
            className="px-2 py-1 rounded text-xs border bg-muted border-border text-subtle disabled:opacity-40"
          >stop</button>
          <button
            disabled={busy === "discord-restart"}
            onClick={async () => {
              setBusy("discord-restart"); setDiscordMsg(null);
              try { const r = await api.discordBotRestart(); setDiscordMsg(`restart: ${r.status}`); }
              catch (e) { setDiscordMsg(`restart failed: ${(e as Error).message}`); } finally { setBusy(null); }
            }}
            className="px-2 py-1 rounded text-xs border bg-warn/20 border-warn text-warn disabled:opacity-40"
          >restart</button>
        </div>
        {discordMsg && <div className="text-xs text-subtle">{discordMsg}</div>}
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
