// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ToggleRow, putJson } from "./common.js";

// ─── リアクションワークフロー (ON/OFF + 絵文字→アクション マッピング) ──────

interface ActionHelp { label: string; summary: string; mode: string }
interface ReactionMappings {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  actions: string[];
  action_help?: Record<string, ActionHelp>;
}

interface ReactionWorkflowStatus {
  enabled: boolean;
  readiness: {
    status: "disabled" | "ready" | "no_authorized_users";
    authorized_user_count: number;
    // 人数は社員名簿 (管理職以上) の集計。 allowlist は廃止済み。
    platforms: {
      discord: { authorized_user_count: number };
      slack: { authorized_user_count: number };
    };
    issues: Array<"discord_no_authorized_users" | "slack_no_authorized_users">;
  };
}

export function ReactionWorkflowSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [readiness, setReadiness] = useState<ReactionWorkflowStatus["readiness"] | null>(null);
  const [maps, setMaps] = useState<ReactionMappings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEmoji, setNewEmoji] = useState("");
  const [newAction, setNewAction] = useState("");

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [s, m] = await Promise.all([
        fetch("/v1/admin/reaction-workflow").then((r) => r.json()),
        fetch("/v1/admin/reaction-mappings").then((r) => r.json()),
      ]);
      const status = s as ReactionWorkflowStatus;
      setEnabled(status.enabled);
      setReadiness(status.readiness);
      setMaps(m as ReactionMappings);
      if (!newAction && (m as ReactionMappings).actions?.length) setNewAction((m as ReactionMappings).actions[0]);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function toggle(v: boolean) {
    setBusy("toggle"); setError(null);
    try { await putJson("/v1/admin/reaction-workflow", { enabled: v }); await refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function addMapping() {
    const emoji = newEmoji.trim();
    if (!emoji || !newAction) return;
    setBusy("add"); setError(null);
    try {
      await putJson("/v1/admin/reaction-mappings", { emoji, action: newAction });
      setNewEmoji("");
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function removeOverride(emoji: string) {
    setBusy(`rm:${emoji}`); setError(null);
    try {
      const r = await fetch(`/v1/admin/reaction-mappings/${encodeURIComponent(emoji)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  // 各アクションの既定トリガ絵文字 (ヘルプ表示用)。
  const defaultEmojisByAction: Record<string, string[]> = {};
  if (maps) {
    for (const [emoji, action] of Object.entries(maps.defaults)) {
      (defaultEmojisByAction[action] ??= []).push(emoji);
    }
  }

  // 既定 + 上書き をマージした実効写像 (表示用)。
  const effective: { emoji: string; action: string; source: "default" | "custom" }[] = [];
  if (maps) {
    const seen = new Set<string>();
    for (const [emoji, action] of Object.entries(maps.overrides)) {
      effective.push({ emoji, action, source: "custom" });
      seen.add(emoji);
    }
    for (const [emoji, action] of Object.entries(maps.defaults)) {
      if (!seen.has(emoji)) effective.push({ emoji, action, source: "default" });
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">リアクションワークフロー</h2>
        <p className="text-subtle text-xs mt-0.5">
          Discord/Slack のリアクション (および単発投稿された絵文字) を「指示」として
          headless claude / session.inject に変換する機能の有効化と、 絵文字→アクション写像。
        </p>
      </div>

      <ToggleRow
        label="リアクションワークフロー"
        hint="ON で 🙏/🫡/📲/👈 等のリアクション・単発絵文字が処理を起動する. デフォルト OFF (記録のみ)."
        value={enabled === null ? null : !enabled}
        onToggle={(v) => toggle(!v)}
        busy={busy === "toggle"}
        onLabel="停止中" offLabel="稼働中" onAction="稼働させる" offAction="停止する"
      />

      {readiness?.status === "no_authorized_users" && (
        <div className="border border-danger bg-danger/10 text-danger rounded p-3 text-xs">
          <div className="font-semibold">実行可能ユーザーなし</div>
          <div className="mt-1">
            ワークフローは ON ですが、 発火権限を持つ社員 (管理職以上) が 1 人も居ないため
            すべての発火を拒否します。 社員ページで役職を設定してください。
          </div>
        </div>
      )}

      {readiness?.status === "ready" && readiness.issues.length > 0 && (
        <div className="border border-accent bg-accent/10 text-accent rounded p-3 text-xs">
          <div className="font-semibold">一部 platform に実行可能ユーザーがいません</div>
          <div className="mt-1">
            {readiness.issues.includes("discord_no_authorized_users") && "Discord に管理職以上の社員が居ません。 "}
            {readiness.issues.includes("slack_no_authorized_users") && "Slack に管理職以上の社員が居ません。"}
          </div>
        </div>
      )}

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">発火できるユーザー</div>
        <div className="text-xs text-subtle">
          allowlist はここには置きません。 発火 (および spawn / end-session) の権限は
          <Link to="/staff" className="text-accent"> 社員</Link> ページの役職で決まります
          (管理職以上が発火可)。
        </div>
        <div className="flex items-center gap-3 text-xs">
          {(["discord", "slack"] as const).map((platform) => {
            const count = readiness?.platforms[platform].authorized_user_count ?? 0;
            return (
              <span key={platform} className={count > 0 ? "text-accent" : "text-danger"}>
                {platform === "discord" ? "Discord" : "Slack"}: 発火権限あり {count} 人
              </span>
            );
          })}
        </div>
      </div>

      <details className="bg-muted/40 border border-border rounded p-3">
        <summary className="text-sm font-medium cursor-pointer">コマンド (ワークフロー) ヘルプ — 各アクションが何をするか</summary>
        <p className="text-xs text-subtle mt-1">
          いずれも「投稿内容を変換して claude に渡す」。 既定の絵文字でトリガーされる。
        </p>
        <ul className="mt-2 space-y-2">
          {maps?.actions.map((a) => {
            const h = maps.action_help?.[a];
            const emojis = defaultEmojisByAction[a] ?? [];
            return (
              <li key={a} className="bg-surface border border-border rounded px-2 py-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base">{emojis.join(" ") || "—"}</span>
                  <span className="font-mono text-xs text-accent">{a}</span>
                  {h?.label && <span className="text-xs font-medium">{h.label}</span>}
                </div>
                {h?.summary && <div className="text-xs text-subtle mt-0.5">{h.summary}</div>}
                {h?.mode && <div className="text-[11px] text-subtle mt-0.5">実行: {h.mode}</div>}
              </li>
            );
          })}
        </ul>
      </details>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-3">
        <div>
          <div className="text-sm font-medium">絵文字 → アクション マッピング</div>
          <div className="text-xs text-subtle mt-0.5">
            デフォルトは組み込み構成。 同じ絵文字に上書き登録すると custom が優先される。
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text" value={newEmoji} onChange={(e) => setNewEmoji(e.target.value)}
            placeholder="絵文字 (例 🔥)" disabled={busy === "add"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm w-28"
          />
          <select
            value={newAction} onChange={(e) => setNewAction(e.target.value)} disabled={busy === "add"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm"
          >
            {maps?.actions.map((a) => (
              <option key={a} value={a}>{maps.action_help?.[a]?.label ? `${a} — ${maps.action_help[a].label}` : a}</option>
            ))}
          </select>
          <button
            disabled={busy === "add" || !newEmoji.trim() || !newAction}
            onClick={() => void addMapping()}
            className="px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
          >追加 / 上書き</button>
        </div>

        <ul className="space-y-1">
          {effective.map((m) => (
            <li key={m.emoji} className="flex items-center gap-2 text-sm bg-surface border border-border rounded px-2 py-1">
              <span className="text-lg w-7 text-center">{m.emoji}</span>
              <span className="text-subtle">→</span>
              <span className="font-mono text-xs" title={maps?.action_help?.[m.action]?.summary}>
                {m.action}{maps?.action_help?.[m.action]?.label ? ` (${maps.action_help[m.action].label})` : ""}
              </span>
              <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] border ${m.source === "custom" ? "bg-accent/20 border-accent text-accent" : "bg-muted border-border text-subtle"}`}>
                {m.source === "custom" ? "custom" : "default"}
              </span>
              {m.source === "custom" && (
                <button
                  disabled={busy === `rm:${m.emoji}`}
                  onClick={() => void removeOverride(m.emoji)}
                  className="ml-auto text-subtle hover:text-danger text-xs"
                >削除</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
