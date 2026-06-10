// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// runtime kill switch (chat-mute / rules-enabled / proposer) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../api.js";

// ─── 共通 UI ────────────────────────────────────────────────────────────

function ToggleRow(props: {
  label: string;
  hint: string;
  /** true = "禁止中" 側 (warn), false = "稼働中" 側 (ok), null = loading */
  value: boolean | null;
  onToggle: (next: boolean) => void;
  busy: boolean;
  onLabel: string;
  offLabel: string;
  onAction: string;
  offAction: string;
}) {
  const on = props.value === true;
  const stateLabel = props.value === null ? "..." : on ? props.onLabel : props.offLabel;
  const actionLabel = props.value === null ? "..." : on ? props.onAction : props.offAction;
  const stateClasses = props.value === null
    ? "bg-muted text-subtle border-border"
    : on ? "bg-warn/20 border-warn text-warn" : "bg-ok/20 border-ok text-ok";
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        <div className="text-xs text-subtle mt-0.5">{props.hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-subtle shrink-0">現在:</span>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs border ${stateClasses}`}>{stateLabel}</span>
        <button
          disabled={props.busy || props.value === null}
          onClick={() => props.onToggle(!on)}
          className="ml-auto shrink-0 px-2 py-1 rounded text-xs border bg-accent/15 border-accent text-accent disabled:opacity-40"
          title={`${stateLabel} → ${actionLabel}`}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

/** 1 行のテキスト設定 (現在値 + 入力 + apply)。 */
function TextSettingRow(props: {
  label: string;
  hint?: React.ReactNode;
  current: string | null;
  placeholder?: string;
  busy: boolean;
  onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => { if (props.current !== null) setDraft(props.current); }, [props.current]);
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        {props.hint && <div className="text-xs text-subtle mt-0.5">{props.hint}</div>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-subtle shrink-0">現在:</span>
        <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
          {props.current !== null ? (props.current || "(未設定)") : "..."}
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={props.busy}
          placeholder={props.placeholder}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono flex-1 min-w-[180px]"
        />
        <button
          disabled={props.busy || draft === (props.current ?? "")}
          onClick={() => props.onApply(draft)}
          className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
        >
          apply
        </button>
      </div>
    </div>
  );
}

/** 複数ワークスペースルートを 1 行 1 パスの textarea で編集する行。 先頭行 = プライマリ。 */
function MultiRootSettingRow(props: {
  current: string[] | null;
  busy: boolean;
  onApply: (roots: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (props.current !== null) setDraft(props.current.join("\n"));
  }, [props.current]);
  const parsed = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const currentJoined = (props.current ?? []).join("\n");
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">ワークスペースルート (複数可)</div>
        <div className="text-xs text-subtle mt-0.5">
          1 行 1 パス。 先頭行がプライマリ (Memoria / Lictor の基点)。 例 <code>E:\Document\Ars</code>。
          空にすると config (env) 既定に戻る。
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0 pt-1">現在:</span>
          <div className="flex flex-col gap-0.5">
            {props.current === null ? (
              <span className="text-xs text-subtle">...</span>
            ) : props.current.length === 0 ? (
              <span className="text-xs text-subtle">(未設定)</span>
            ) : (
              props.current.map((r, i) => (
                <span key={r} className="px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
                  {i === 0 ? "★ " : ""}{r}
                </span>
              ))
            )}
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={props.busy}
          rows={3}
          placeholder={"E:\\Document\\Ars\nD:\\Other\\Workspace"}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono w-full"
        />
        <button
          disabled={props.busy || parsed.join("\n") === currentJoined}
          onClick={() => props.onApply(parsed)}
          className="self-start px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
        >
          apply
        </button>
      </div>
    </div>
  );
}

async function putJson(path: string, body: unknown): Promise<void> {
  const r = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
}

// ─── ランタイム制御 (旧 Rules / AdminTogglesPanel) ───────────────────────

export function RuntimeControlsSection() {
  const [chatMuted, setChatMuted] = useState<boolean | null>(null);
  const [rulesEnabled, setRulesEnabled] = useState<boolean | null>(null);
  const [intervalSec, setIntervalSec] = useState<number | null>(null);
  const [minSec, setMinSec] = useState<number>(60);
  const [maxSec, setMaxSec] = useState<number>(86400);
  const [intervalDraft, setIntervalDraft] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discordMsg, setDiscordMsg] = useState<string | null>(null);

  useEffect(() => { void refreshAll(); }, []);

  async function refreshAll() {
    try {
      const r = await fetch("/v1/admin/state");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = (await r.json()) as {
        chat_muted: boolean; rules_enabled: boolean; rule_proposer_interval_sec: number;
        proposer_interval_min_sec: number; proposer_interval_max_sec: number;
      };
      setChatMuted(s.chat_muted);
      setRulesEnabled(s.rules_enabled);
      setIntervalSec(s.rule_proposer_interval_sec);
      setIntervalDraft(String(s.rule_proposer_interval_sec));
      setMinSec(s.proposer_interval_min_sec);
      setMaxSec(s.proposer_interval_max_sec);
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
          dispatcher / rule engine / proposer の停止スイッチ. 即時反映 + 再起動後も維持.
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
          label="チャットルール改善禁止 (rules-enabled)"
          hint="OFF で rule engine + proposer の claude 呼び出しを skip. デフォルト OFF (=禁止)."
          value={rulesEnabled === null ? null : !rulesEnabled}
          onToggle={(v) => put("/v1/admin/rules-enabled", { enabled: !v }, "rules-enabled")}
          busy={busy === "rules-enabled"}
          onLabel="禁止中" offLabel="稼働中" onAction="稼働させる" offAction="禁止する"
        />
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div>
          <div className="text-sm font-medium">proposer interval</div>
          <div className="text-xs text-subtle mt-0.5">rule proposer の tick 間隔. 範囲 [{minSec}, {maxSec}] sec.</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">現在:</span>
          <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok">
            {intervalSec !== null ? `${intervalSec}s (${Math.round(intervalSec / 60)} 分)` : "..."}
          </span>
          <input
            type="number" min={minSec} max={maxSec} value={intervalDraft}
            onChange={(e) => setIntervalDraft(e.target.value)} disabled={busy === "interval"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono w-24 ml-auto"
          />
          <button
            disabled={busy === "interval" || intervalDraft === String(intervalSec ?? "")}
            onClick={() => put("/v1/admin/rule-proposer-interval", { interval_sec: Number(intervalDraft) }, "interval")}
            className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
          >apply</button>
        </div>
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

// ─── リアクションワークフロー (ON/OFF + 絵文字→アクション マッピング) ──────

interface ActionHelp { label: string; summary: string; mode: string }
interface ReactionMappings {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  actions: string[];
  action_help?: Record<string, ActionHelp>;
}

export function ReactionWorkflowSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
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
      setEnabled((s as { enabled: boolean }).enabled);
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

// ─── ワークスペース ( workspace root + GitHub Org) ────────────────────────

export function WorkspaceSection() {
  const [workspaceRoots, setWorkspaceRoots] = useState<string[] | null>(null);
  const [githubOrg, setGithubOrg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/state").then((r) => r.json())) as {
        workspace_roots: string[]; github_org: string;
      };
      setWorkspaceRoots(s.workspace_roots ?? []);
      setGithubOrg(s.github_org);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply(path: string, body: unknown, key: string) {
    setBusy(key); setError(null);
    try { await putJson(path, body); await refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">ワークスペース</h2>
        <p className="text-subtle text-xs mt-0.5">
          ローカルクローン親 (リアクションWF / Work 走査の基点) と GitHub Organization。
          保存は schema_meta 永続化。 リアクションWF の cwd 反映は次の bot 再起動後。
        </p>
      </div>
      <MultiRootSettingRow
        current={workspaceRoots} busy={busy === "ws"}
        onApply={(roots) => apply("/v1/admin/workspace-roots", { workspace_roots: roots }, "ws")}
      />
      <TextSettingRow
        label="GitHub Organization"
        hint={<>例 <code>LUDIARS</code>。 PR / repo 操作の owner 解決に使う。</>}
        current={githubOrg} placeholder="LUDIARS" busy={busy === "org"}
        onApply={(v) => apply("/v1/admin/github-org", { github_org: v }, "org")}
      />
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}

// ─── コスト予算 (日次トークン上限 + 超過ブロック) ────────────────────────

export function CostBudgetSection() {
  const [budget, setBudget] = useState<number | null>(null);
  const [today, setToday] = useState<number>(0);
  const [blocked, setBlocked] = useState<boolean>(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    // 当日消費は変化するので定期的に再取得 (30s)。
    const t = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/cost-budget").then((r) => r.json())) as {
        daily_token_budget: number; today_tokens: number; blocked: boolean;
      };
      setBudget(s.daily_token_budget);
      setToday(s.today_tokens);
      setBlocked(s.blocked);
      setDraft(String(s.daily_token_budget));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) { setError("0 以上の数値を入力"); return; }
    setBusy(true); setError(null);
    try {
      await putJson("/v1/admin/cost-budget", { daily_token_budget: Math.floor(n) });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const pct = budget && budget > 0 ? Math.min(100, Math.round((today / budget) * 100)) : 0;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">コスト予算 (日次トークン)</h2>
        <p className="text-subtle text-xs mt-0.5">
          当日 (ローカル日) のトークン消費合計が上限に達したら、 Concordia 発の命令
          (新規 spawn / dispatcher 発話 / リアクションWF / rule engine) を止める。
          外部バッチ・別ツール起動の Claude/Codex も合算対象。 0 = 無効。
        </p>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-subtle">当日消費:</span>
          <span className="font-mono">{today.toLocaleString()} tok</span>
          <span className="text-subtle">/ 予算:</span>
          <span className="font-mono">{budget === null ? "..." : budget === 0 ? "(無効)" : budget.toLocaleString()}</span>
          {blocked && (
            <span className="px-2 py-0.5 rounded text-xs border bg-danger/20 border-danger text-danger">
              ⛔ ブロック中
            </span>
          )}
        </div>
        {budget !== null && budget > 0 && (
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div
              className={`h-full ${blocked ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-ok"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">上限 (tok):</span>
          <input
            type="number"
            min={0}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            placeholder="0 = 無効 (例 2000000)"
            className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono flex-1 min-w-[160px]"
          />
          <button
            disabled={busy || draft === String(budget ?? "")}
            onClick={() => void apply()}
            className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
          >
            apply
          </button>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}

// ─── Lictor 起動設定 (mode + dev/prod パス) ──────────────────────────────

export function LictorSection() {
  const [mode, setMode] = useState<string | null>(null);
  const [devPath, setDevPath] = useState<string | null>(null);
  const [prodExe, setProdExe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/lictor").then((r) => r.json())) as {
        lictor_mode: string; lictor_dev_path: string; lictor_prod_exe: string;
      };
      setMode(s.lictor_mode);
      setDevPath(s.lictor_dev_path);
      setProdExe(s.lictor_prod_exe);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply(body: unknown, key: string) {
    setBusy(key); setError(null);
    try { await putJson("/v1/admin/lictor", body); await refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">Lictor 起動設定</h2>
        <p className="text-subtle text-xs mt-0.5">
          spawn が Lictor をどう起動するか。 auto = PATH 上の <code>lictor</code> (従来)、
          dev = ローカルリポを <code>node bin/lictor.mjs</code> で実行、 prod = 同梱 exe を直接実行。
          PATH に lictor が無く spawn に失敗する環境向け。
        </p>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">モード</div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">現在:</span>
          <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
            {mode ?? "..."}
          </span>
          <select
            value={mode ?? "auto"} onChange={(e) => apply({ lictor_mode: e.target.value }, "mode")}
            disabled={busy === "mode"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm ml-auto"
          >
            <option value="auto">auto (PATH の lictor)</option>
            <option value="dev">dev (ローカルリポ)</option>
            <option value="prod">prod (同梱 exe)</option>
          </select>
        </div>
      </div>

      <TextSettingRow
        label="dev リポパス"
        hint={<>dev モードで使う Lictor リポ root。 <code>node &lt;path&gt;\bin\lictor.mjs</code> を起動。</>}
        current={devPath} placeholder="E:\\Document\\Ars\\Lictor" busy={busy === "dev"}
        onApply={(v) => apply({ lictor_dev_path: v }, "dev")}
      />
      <TextSettingRow
        label="prod exe パス"
        hint={<>prod モードで使う同梱 Lictor exe (Release 公開物) の絶対パス。</>}
        current={prodExe} placeholder="C:\\path\\to\\lictor.exe" busy={busy === "prod"}
        onApply={(v) => apply({ lictor_prod_exe: v }, "prod")}
      />
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
