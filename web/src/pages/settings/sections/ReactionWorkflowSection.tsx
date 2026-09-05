// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { putJson } from "./common.js";
import { ReactionSkillWorkflowsPanel } from "./ReactionSkillWorkflows.js";

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

/** @implements spec/tasks/2026-08-09-settings-duplicate-display-cleanup.md */
export function ReactionWorkflowSection({ onOpenAllSettings }: { onOpenAllSettings: () => void }) {
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

      <div className="bg-muted/40 border border-border rounded p-3 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-subtle">状態</span>
          <span className={"text-xs px-2 py-0.5 rounded border " + (enabled ? "bg-ok/20 border-ok text-ok" : "bg-muted border-border text-subtle")}>
            {enabled === null ? "..." : enabled ? "稼働中" : "停止中 (記録のみ)"}
          </span>
        </div>
        <p className="text-subtle text-xs">
          ON で 🙏/🫡/📲/👈 等のリアクション・単発絵文字が処理を起動する。 既定は OFF。
          切り替えは <strong>設定 &gt; すべて</strong> で行う (<code>workflow.reaction_enabled</code>)。
          {" "}
          <button
            type="button"
            onClick={onOpenAllSettings}
            className="underline text-accent hover:text-accent/80"
          >
            すべての設定を開く
          </button>
        </p>
      </div>

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

      <ReactionSkillWorkflowsPanel actionOptions={maps?.actions ?? []} />

      <ActionPolicyTable actionHelp={maps?.action_help} />

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}

// ─── アクション別ポリシー (子会社可否 / 要求権限) — 2026-09-02 neco 指示 ──────

interface ActionPolicyRow {
  action: string;
  help: ActionHelp | null;
  defaults: { subsidiary: boolean; capability: string | null };
  override: { subsidiary?: boolean; capability?: string } | null;
}

const CAPABILITY_JA: Record<string, string> = {
  none: "不要",
  session_spawn: "セッション起動 (管理職)",
  merge_pr: "マージ (管理職)",
  kill_switch: "キルスイッチ (役員)",
  session_end: "セッション終了 (管理職)",
};

function ActionPolicyTable({ actionHelp }: { actionHelp?: Record<string, ActionHelp> }) {
  const [rows, setRows] = useState<ActionPolicyRow[] | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const r = await fetch("/v1/admin/reaction-action-policies").then((res) => res.json()) as {
        actions: ActionPolicyRow[]; capabilities: string[];
      };
      setRows(r.actions);
      setCapabilities(r.capabilities);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function update(action: string, patch: { subsidiary?: boolean | null; capability?: string | null }) {
    setBusy(action); setError(null);
    try {
      await putJson("/v1/admin/reaction-action-policies", { action, ...patch });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-3">
      <div>
        <div className="text-sm font-medium">アクション別ポリシー (本社/子会社・要求権限)</div>
        <div className="text-xs text-subtle mt-0.5">
          子会社 Bot で動かすか (既定: Memoria 記録系のみ本社限定 — 子会社からは Memoria を
          見られないため) と、発火に必要な権限をアクションごとに上書きできます。
        </div>
      </div>
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-[11px] text-subtle border-b border-border">
            <th className="py-1 pr-2 font-medium">アクション</th>
            <th className="py-1 pr-2 font-medium">子会社</th>
            <th className="py-1 font-medium">要求権限</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row) => {
            const subsidiaryValue = row.override?.subsidiary === undefined
              ? "" : row.override.subsidiary ? "on" : "off";
            const capabilityValue = row.override?.capability ?? "";
            const help = actionHelp?.[row.action] ?? row.help ?? undefined;
            return (
              <tr key={row.action} className="border-b border-border/50">
                <td className="py-1 pr-2">
                  <span className="font-mono text-xs text-accent" title={help?.summary}>{row.action}</span>
                  {help?.label && <span className="text-xs text-subtle ml-1">{help.label}</span>}
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={subsidiaryValue}
                    disabled={busy === row.action}
                    onChange={(e) => {
                      const v = e.target.value;
                      void update(row.action, { subsidiary: v === "" ? null : v === "on" });
                    }}
                    className="bg-muted border border-border rounded px-1.5 py-0.5 text-xs"
                  >
                    <option value="">既定 ({row.defaults.subsidiary ? "有効" : "本社のみ"})</option>
                    <option value="on">有効</option>
                    <option value="off">本社のみ</option>
                  </select>
                </td>
                <td className="py-1">
                  <select
                    value={capabilityValue}
                    disabled={busy === row.action}
                    onChange={(e) => {
                      const v = e.target.value;
                      void update(row.action, { capability: v === "" ? null : v });
                    }}
                    className="bg-muted border border-border rounded px-1.5 py-0.5 text-xs"
                  >
                    <option value="">
                      既定 ({row.defaults.capability ? CAPABILITY_JA[row.defaults.capability] ?? row.defaults.capability : "不要"})
                    </option>
                    <option value="none">不要</option>
                    {capabilities.map((cap) => (
                      <option key={cap} value={cap}>{CAPABILITY_JA[cap] ?? cap}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <div className="text-danger text-xs">{error}</div>}
    </div>
  );
}
