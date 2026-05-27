import { useEffect, useState } from "react";
import { api, fmtTs } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

interface RuleForm {
  id: string;
  description: string;
  trigger_type: "tick" | "event";
  tick_sec: string;
  event_kind: string;
  cooldown_sec: string;
  instructions: string;
  /** create 時のみ意味あり: false = review-pending で disabled. true = 即時 enabled. */
  enabled: boolean;
}

const EMPTY_FORM: RuleForm = {
  id: "",
  description: "",
  trigger_type: "tick",
  tick_sec: "300",
  event_kind: "",
  cooldown_sec: "300",
  instructions: "",
  enabled: false,
};

interface Rule {
  id: string;
  description: string | null;
  trigger_type: "tick" | "event";
  tick_sec: number | null;
  event_kind: string | null;
  conditions: any;
  instructions: string;
  target: string | null;
  cooldown_sec: number;
  last_fired_at: number | null;
  enabled: boolean;
  added_at: number;
  added_by: string;
  removed_at: number | null;
  removed_by: string | null;
  removed_reason: string | null;
}

interface RuleLog {
  id: number;
  ts: number;
  rule_id: string | null;
  action: string;
  detail: string | null;
  actor: string;
}

type FormMode = { kind: "create" } | { kind: "edit"; ruleId: string };

export function Rules() {
  const { data: rulesData, error, refetch } = useLiveQuery<{ rules: Rule[] }>(
    () => fetch("/v1/rules").then((r) => r.json()),
    ["rule.changed"],
  );
  const { data: logData } = useLiveQuery<{ logs: RuleLog[] }>(
    () => fetch("/v1/rules/log?limit=50").then((r) => r.json()),
    ["rule.changed"],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [aiAssisting, setAiAssisting] = useState(false);
  const [eventKinds, setEventKinds] = useState<string[]>(["*"]);

  // event_kind dropdown 用に backend から候補を取る
  useEffect(() => {
    fetch("/v1/rules/event-kinds")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.event_kinds)) setEventKinds(j.event_kinds);
      })
      .catch(() => {});
  }, []);

  const startCreate = () => {
    setMode({ kind: "create" });
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const startEdit = (r: Rule) => {
    setMode({ kind: "edit", ruleId: r.id });
    setForm({
      id: r.id,
      description: r.description ?? "",
      trigger_type: r.trigger_type,
      tick_sec: r.tick_sec != null ? String(r.tick_sec) : "300",
      event_kind: r.event_kind ?? "",
      cooldown_sec: String(r.cooldown_sec),
      instructions: r.instructions,
      enabled: r.enabled,
    });
    setFormError(null);
  };

  const cancelForm = () => {
    setMode(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const toggle = async (id: string) => {
    setBusy(id);
    await fetch(`/v1/rules/${encodeURIComponent(id)}/toggle`, { method: "POST" });
    refetch();
    setBusy(null);
  };

  const remove = async (id: string) => {
    if (!confirm(`rule "${id}" を削除しますか?`)) return;
    setBusy(id);
    const reason = prompt("削除理由 (任意):") ?? "";
    await fetch(`/v1/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    refetch();
    setBusy(null);
  };

  const aiAssist = async () => {
    setAiAssisting(true);
    setFormError(null);
    try {
      const partial: any = {};
      if (form.id) partial.id = form.id;
      if (form.description) partial.description = form.description;
      partial.trigger_type = form.trigger_type;
      if (form.trigger_type === "tick" && form.tick_sec) partial.tick_sec = Number(form.tick_sec);
      if (form.trigger_type === "event" && form.event_kind) partial.event_kind = form.event_kind;
      if (form.cooldown_sec) partial.cooldown_sec = Number(form.cooldown_sec);
      if (form.instructions) partial.instructions = form.instructions;

      const r = await fetch("/v1/rules/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partial }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setFormError(`AI 補完失敗: ${(j as any).error ?? r.status}`);
        return;
      }
      const j = await r.json();
      const rule = j.rule ?? {};
      // ユーザが既に埋めた値は上書きしない (空のスロットだけ AI 候補で埋める)
      setForm((prev) => ({
        id: prev.id || (rule.id ?? ""),
        description: prev.description || (rule.description ?? ""),
        trigger_type: prev.trigger_type, // ユーザ選択尊重
        tick_sec:
          prev.trigger_type === "tick"
            ? prev.tick_sec || (rule.tick_sec != null ? String(rule.tick_sec) : "300")
            : prev.tick_sec,
        event_kind:
          prev.trigger_type === "event"
            ? prev.event_kind || (rule.event_kind ?? "")
            : prev.event_kind,
        cooldown_sec: prev.cooldown_sec || (rule.cooldown_sec != null ? String(rule.cooldown_sec) : "300"),
        instructions: prev.instructions || (rule.instructions ?? ""),
        enabled: prev.enabled,
      }));
    } finally {
      setAiAssisting(false);
    }
  };

  const submitForm = async () => {
    setFormError(null);
    if (!form.instructions) {
      setFormError("instructions は必須です");
      return;
    }
    if (mode?.kind === "create" && !form.id) {
      setFormError("id は必須です");
      return;
    }
    setFormSubmitting(true);
    try {
      const isEdit = mode?.kind === "edit";
      const body: any = {
        description: form.description || null,
        trigger_type: form.trigger_type,
        instructions: form.instructions,
        cooldown_sec: Number(form.cooldown_sec) || 60,
      };
      if (form.trigger_type === "tick") {
        body.tick_sec = Number(form.tick_sec) || 300;
        body.event_kind = null;
      } else {
        body.event_kind = form.event_kind || null;
        body.tick_sec = null;
      }
      let r: Response;
      if (isEdit) {
        r = await fetch(`/v1/rules/${encodeURIComponent((mode as any).ruleId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        body.id = form.id;
        body.conditions = [];
        body.enabled = form.enabled;
        r = await fetch("/v1/rules", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setFormError((j as any).error ?? `${r.status}`);
        return;
      }
      cancelForm();
      refetch();
    } finally {
      setFormSubmitting(false);
    }
  };

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  const rules = rulesData?.rules ?? [];
  const logs = logData?.logs ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-3">
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="font-semibold">Rules</h1>
            <p className="text-subtle text-sm mt-1">
              Concordia 内蔵 rule engine. tick または event で claude CLI を spawn し、
              chat 投稿 / rule の追加削除を判断する. 人間も rule を提案できる.
            </p>
          </div>
          {!mode && (
            <button
              onClick={startCreate}
              className="px-3 py-1 bg-accent/20 border border-accent text-accent rounded text-sm"
            >
              + propose rule
            </button>
          )}
        </header>

        <AdminTogglesPanel />

        {mode && (
          <RuleForm
            mode={mode}
            form={form}
            setForm={setForm}
            eventKinds={eventKinds}
            formError={formError}
            formSubmitting={formSubmitting}
            aiAssisting={aiAssisting}
            onAssist={() => void aiAssist()}
            onSubmit={() => void submitForm()}
            onCancel={cancelForm}
          />
        )}

        {rules.length === 0 && (
          <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">no rules</div>
        )}

        {rules.map((r) => (
          <article key={r.id} className="bg-surface border border-border rounded p-3">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={
                  "px-1.5 py-0.5 rounded " +
                  (r.enabled
                    ? "bg-ok/20 text-ok"
                    : !r.removed_at && r.added_by === "human"
                      ? "bg-warn/20 text-warn"
                      : "bg-subtle/20 text-subtle")
                }
              >
                {r.enabled
                  ? "enabled"
                  : !r.removed_at && r.added_by === "human"
                    ? "review待ち"
                    : "disabled"}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-muted">{r.trigger_type}</span>
              {r.tick_sec && (
                <span className="text-subtle">every {r.tick_sec}s</span>
              )}
              {r.event_kind && (
                <span className="text-subtle">on {r.event_kind}</span>
              )}
              <span className="text-subtle">cooldown {r.cooldown_sec}s</span>
              <span className="ml-auto text-subtle">by {r.added_by}</span>
              <button
                onClick={() => startEdit(r)}
                disabled={busy === r.id}
                className="ml-2 text-subtle hover:text-accent"
              >
                edit
              </button>
              <button
                onClick={() => toggle(r.id)}
                disabled={busy === r.id}
                className="text-subtle hover:text-accent"
              >
                toggle
              </button>
              <button
                onClick={() => remove(r.id)}
                disabled={busy === r.id}
                className="text-subtle hover:text-danger"
              >
                remove
              </button>
            </div>
            <h2 className="mt-2 font-mono">{r.id}</h2>
            {r.description && <div className="text-subtle text-sm">{r.description}</div>}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-subtle">instructions</summary>
              <pre className="mt-1 bg-muted p-2 rounded whitespace-pre-wrap">{r.instructions}</pre>
            </details>
            <div className="mt-2 flex gap-3 text-[11px] text-subtle">
              {r.last_fired_at && <span>last fired: {fmtTs(r.last_fired_at)}</span>}
              {r.removed_at && (
                <span className="text-warn">
                  removed by {r.removed_by} @ {fmtTs(r.removed_at)} ({r.removed_reason ?? "?"})
                </span>
              )}
            </div>
          </article>
        ))}
      </div>

      <aside className="space-y-2">
        <h2 className="font-semibold">最近のログ</h2>
        <ul className="space-y-1">
          {logs.map((l) => (
            <li
              key={l.id}
              className="bg-surface border border-border rounded px-2 py-1 text-[11px]"
            >
              <div className="flex items-center gap-2">
                <span className={actionColor(l.action)}>{l.action}</span>
                <span className="text-subtle font-mono">{l.rule_id ?? "-"}</span>
                <span className="text-subtle ml-auto">{fmtTs(l.ts)}</span>
              </div>
              {l.detail && (
                <div className="text-subtle mt-0.5 truncate">[{l.actor}] {l.detail}</div>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function RuleForm({
  mode, form, setForm, eventKinds, formError, formSubmitting, aiAssisting,
  onAssist, onSubmit, onCancel,
}: {
  mode: FormMode;
  form: RuleForm;
  setForm: (f: RuleForm) => void;
  eventKinds: string[];
  formError: string | null;
  formSubmitting: boolean;
  aiAssisting: boolean;
  onAssist: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const isEdit = mode.kind === "edit";
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="bg-surface border border-border rounded p-3 space-y-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">
          {isEdit ? `rule "${(mode as any).ruleId}" を編集` : "新 rule 提案 (human)"}
        </h2>
        <button
          type="button"
          onClick={onAssist}
          disabled={aiAssisting}
          className="ml-auto px-2 py-1 bg-warn/20 border border-warn text-warn rounded text-xs disabled:opacity-50"
          title="未入力の項目を AI に補完してもらう (claude CLI 経由 / 既入力は尊重)"
        >
          {aiAssisting ? "AI 補完中…" : "✨ AI に補完してもらう"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="id (unique)"
          value={form.id}
          onChange={(v) => setForm({ ...form, id: v })}
          placeholder="my-rule-id"
          required={!isEdit}
          disabled={isEdit}
        />
        <Input
          label="description"
          value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
          placeholder="どんな rule か (任意)"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col">
          <span className="text-subtle text-xs">trigger</span>
          <select
            value={form.trigger_type}
            onChange={(e) => setForm({ ...form, trigger_type: e.target.value as "tick" | "event" })}
            className="bg-muted border border-border rounded px-2 py-1"
          >
            <option value="tick">tick (周期実行)</option>
            <option value="event">event (発生時)</option>
          </select>
        </label>
        {form.trigger_type === "tick" ? (
          <Input
            label="tick_sec (周期)"
            value={form.tick_sec}
            onChange={(v) => setForm({ ...form, tick_sec: v })}
            type="number"
          />
        ) : (
          <label className="flex flex-col">
            <span className="text-subtle text-xs">event_kind</span>
            <select
              value={form.event_kind}
              onChange={(e) => setForm({ ...form, event_kind: e.target.value })}
              className="bg-muted border border-border rounded px-2 py-1"
            >
              <option value="">(全 event / 任意)</option>
              {eventKinds.map((ek) => (
                <option key={ek} value={ek}>
                  {ek === "*" ? "* (全 event)" : ek}
                </option>
              ))}
            </select>
          </label>
        )}
        <Input
          label="cooldown_sec"
          value={form.cooldown_sec}
          onChange={(v) => setForm({ ...form, cooldown_sec: v })}
          type="number"
        />
      </div>
      <label className="flex flex-col">
        <span className="text-subtle text-xs">instructions (claude CLI に渡す指示)</span>
        <textarea
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono min-h-[100px]"
          placeholder="例: 「直近 30 分で edit が 0 件なら chitchat に『一服中?』 と投稿」"
          required
        />
      </label>
      {!isEdit && (
        <label className="flex items-center gap-2 text-xs text-subtle pt-1">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>
            即時 enabled で投入する (off の場合は review 待ち disabled で保存され、 上の toggle で有効化)
          </span>
        </label>
      )}
      {formError && <div className="text-danger text-xs">{formError}</div>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="text-subtle text-sm">cancel</button>
        <button
          type="submit"
          disabled={formSubmitting}
          className="px-3 py-1 bg-accent/30 border border-accent text-text rounded text-sm disabled:opacity-50"
        >
          {formSubmitting
            ? "..."
            : isEdit
              ? "save"
              : form.enabled
                ? "propose & enable"
                : "propose (review)"}
        </button>
      </div>
      {!isEdit && (
        <p className="text-subtle text-[11px]">
          既定は <strong>review 待ち</strong> (disabled で保存). 中身を確認してから toggle で有効化.
          チェックを入れた場合は即時 enabled になり、 AI が「不要」と判断すれば後から削除される可能性あり (log に残る).
        </p>
      )}
    </form>
  );
}

function Input({
  label, value, onChange, placeholder, type = "text", required, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col">
      <span className="text-subtle text-xs">{label}{required && <span className="text-danger ml-1">*</span>}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono disabled:opacity-50"
        required={required}
        disabled={disabled}
      />
    </label>
  );
}

/**
 * Runtime toggles for the dispatcher + rule engine + proposer.
 * Lives under /v1/admin/{chat-mute,rules-enabled,rule-proposer-interval}
 * and persists in schema_meta so survives restarts.
 */
function AdminTogglesPanel() {
  const [chatMuted, setChatMuted] = useState<boolean | null>(null);
  const [rulesEnabled, setRulesEnabled] = useState<boolean | null>(null);
  const [intervalSec, setIntervalSec] = useState<number | null>(null);
  const [minSec, setMinSec] = useState<number>(60);
  const [maxSec, setMaxSec] = useState<number>(86400);
  const [intervalDraft, setIntervalDraft] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discordMsg, setDiscordMsg] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  async function refreshAll() {
    try {
      const r = await fetch("/v1/admin/state");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = (await r.json()) as {
        chat_muted: boolean;
        rules_enabled: boolean;
        rule_proposer_interval_sec: number;
        proposer_interval_min_sec: number;
        proposer_interval_max_sec: number;
      };
      setChatMuted(s.chat_muted);
      setRulesEnabled(s.rules_enabled);
      setIntervalSec(s.rule_proposer_interval_sec);
      setIntervalDraft(String(s.rule_proposer_interval_sec));
      setMinSec(s.proposer_interval_min_sec);
      setMaxSec(s.proposer_interval_max_sec);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function put(path: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status}: ${txt}`);
      }
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bg-surface border border-border rounded p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="font-semibold text-sm">runtime kill switches</h2>
          <p className="text-subtle text-xs mt-0.5">
            dispatcher / rule engine / proposer の停止スイッチ. 即時反映 + 再起動後も維持.
          </p>
        </div>
        <button
          onClick={() => void refreshAll()}
          className="text-xs px-2 py-0.5 bg-muted border border-border rounded"
        >
          refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleRow
          label="チャット禁止 (chat-mute)"
          hint="ON にすると chitchat / chat-reply / session-end report などを enqueue しない. デフォルト ON."
          value={chatMuted}
          onToggle={(v) => put("/v1/admin/chat-mute", { muted: v }, "chat-mute")}
          busy={busy === "chat-mute"}
          onLabel="禁止中"
          offLabel="稼働中"
          onAction="稼働させる"
          offAction="禁止する"
        />
        <ToggleRow
          label="チャットルール改善禁止 (rules-enabled)"
          hint="OFF にすると rule engine + proposer の claude 呼び出しを skip. デフォルト OFF (=禁止)."
          value={rulesEnabled === null ? null : !rulesEnabled}
          onToggle={(v) => put("/v1/admin/rules-enabled", { enabled: !v }, "rules-enabled")}
          busy={busy === "rules-enabled"}
          onLabel="禁止中"
          offLabel="稼働中"
          onAction="稼働させる"
          offAction="禁止する"
        />
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div>
          <div className="text-sm font-medium">proposer interval</div>
          <div className="text-xs text-subtle mt-0.5">
            rule proposer の tick 間隔. 範囲 [{minSec}, {maxSec}] sec.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">現在:</span>
          <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok">
            {intervalSec !== null
              ? `${intervalSec}s (${Math.round(intervalSec / 60)} 分)`
              : "..."}
          </span>
          <input
            type="number"
            min={minSec}
            max={maxSec}
            value={intervalDraft}
            onChange={(e) => setIntervalDraft(e.target.value)}
            disabled={busy === "interval"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono w-24 ml-auto"
          />
          <button
            disabled={busy === "interval" || intervalDraft === String(intervalSec ?? "")}
            onClick={() =>
              put(
                "/v1/admin/rule-proposer-interval",
                { interval_sec: Number(intervalDraft) },
                "interval",
              )
            }
            className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
          >
            apply
          </button>
        </div>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">Discord Bot</div>
        <div className="text-xs text-subtle">Discord bot のみ再起動/起動/停止します（Concordia本体は再起動しません）。</div>
        <div className="flex items-center gap-2">
          <button
            disabled={busy === "discord-start"}
            onClick={async () => {
              setBusy("discord-start");
              setDiscordMsg(null);
              try {
                const r = await api.discordBotStart();
                setDiscordMsg(`start: ${r.status}`);
              } catch (e) {
                setDiscordMsg(`start failed: ${(e as Error).message}`);
              } finally {
                setBusy(null);
              }
            }}
            className="px-2 py-1 rounded text-xs border bg-accent/15 border-accent text-accent disabled:opacity-40"
          >
            start
          </button>
          <button
            disabled={busy === "discord-stop"}
            onClick={async () => {
              setBusy("discord-stop");
              setDiscordMsg(null);
              try {
                const r = await api.discordBotStop();
                setDiscordMsg(`stop: ${r.status}`);
              } catch (e) {
                setDiscordMsg(`stop failed: ${(e as Error).message}`);
              } finally {
                setBusy(null);
              }
            }}
            className="px-2 py-1 rounded text-xs border bg-muted border-border text-subtle disabled:opacity-40"
          >
            stop
          </button>
          <button
            disabled={busy === "discord-restart"}
            onClick={async () => {
              setBusy("discord-restart");
              setDiscordMsg(null);
              try {
                const r = await api.discordBotRestart();
                setDiscordMsg(`restart: ${r.status}`);
              } catch (e) {
                setDiscordMsg(`restart failed: ${(e as Error).message}`);
              } finally {
                setBusy(null);
              }
            }}
            className="px-2 py-1 rounded text-xs border bg-warn/20 border-warn text-warn disabled:opacity-40"
          >
            restart
          </button>
        </div>
        {discordMsg && <div className="text-xs text-subtle">{discordMsg}</div>}
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}

function ToggleRow(props: {
  label: string;
  hint: string;
  /** true = "禁止中" 側 (warn), false = "稼働中" 側 (ok), null = loading */
  value: boolean | null;
  onToggle: (next: boolean) => void;
  busy: boolean;
  /** value=true のとき表示する現在状態 (例: "禁止中") */
  onLabel: string;
  /** value=false のとき表示する現在状態 (例: "稼働中") */
  offLabel: string;
  /** value=true のときボタンに表示する action (例: "稼働させる") */
  onAction: string;
  /** value=false のときボタンに表示する action (例: "禁止する") */
  offAction: string;
}) {
  const on = props.value === true;
  const stateLabel = props.value === null ? "..." : on ? props.onLabel : props.offLabel;
  const actionLabel = props.value === null ? "..." : on ? props.onAction : props.offAction;
  const stateClasses = props.value === null
    ? "bg-muted text-subtle border-border"
    : on
      ? "bg-warn/20 border-warn text-warn"
      : "bg-ok/20 border-ok text-ok";
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        <div className="text-xs text-subtle mt-0.5">{props.hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-subtle shrink-0">現在:</span>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs border ${stateClasses}`}>
          {stateLabel}
        </span>
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

function actionColor(action: string): string {
  switch (action) {
    case "fire":   return "px-1 rounded bg-accent/20 text-accent";
    case "add":    return "px-1 rounded bg-ok/20 text-ok";
    case "remove": return "px-1 rounded bg-warn/20 text-warn";
    case "skip":   return "px-1 rounded bg-subtle/20 text-subtle";
    case "error":  return "px-1 rounded bg-danger/20 text-danger";
    default:       return "px-1 rounded bg-muted text-subtle";
  }
}
