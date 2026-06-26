import { useEffect, useState, useCallback } from "react";
import {
  api,
  fmtTs,
  type HarnessRule,
  type SubsidiarySummary,
  type SubsidiaryInput,
  type SubsidiaryDelegation,
  type SubsidiaryLock,
  type SubsidiaryRequest,
  type DelegationTemplateLite,
} from "../api.js";

/**
 * 子会社 Delegation ダッシュボード。
 *  - 共通ハーネスルール: 子会社ガード (Sonnet) のポリシーを「強固に設定」するセクション。
 *  - 子会社管理: 出張先 (別 Discord/Slack)・専用 Bot・専用 delegation・ガードスコープ。
 * spec/feature/subsidiary-delegation.md。
 */
export function Subsidiaries() {
  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <HarnessRulesSection />
      <SubsidiariesSection />
    </div>
  );
}

// ─── 共通ハーネスルール ──────────────────────────────────────────────

function HarnessRulesSection() {
  const [rules, setRules] = useState<HarnessRule[]>([]);
  const [draft, setDraft] = useState<{ kind: "allow" | "block"; title: string; description: string }>({
    kind: "block",
    title: "",
    description: "",
  });
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.harnessRulesList(true).then((r) => setRules(r.rules)).catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  const toggle = async (r: HarnessRule) => {
    await api.harnessRuleUpdate(r.id, { enabled: !r.enabled });
    load();
  };
  const remove = async (r: HarnessRule) => {
    const res = await api.harnessRuleDelete(r.id);
    if (!res.ok) setErr(res.error === "builtin_cannot_delete" ? "既定ルールは削除できません (無効化のみ可)" : String(res.error));
    load();
  };
  const add = async () => {
    if (!draft.description.trim()) return;
    await api.harnessRuleCreate({ kind: draft.kind, title: draft.title, description: draft.description });
    setDraft({ kind: "block", title: "", description: "" });
    load();
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">共通ハーネスルール</h2>
      <p className="text-subtle text-xs mb-3">
        子会社ガード (Sonnet) が全依頼を判定するときに参照するポリシー。 allow=許可方針 / block=遮断方針。
        既定ルールは無効化のみ可 (削除不可)。
      </p>
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}
      <div className="flex flex-col gap-2 mb-4">
        {rules.map((r) => (
          <div
            key={r.id}
            className={`border border-border rounded-md p-2 flex items-start gap-3 ${r.enabled ? "" : "opacity-50"}`}
          >
            <span
              className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
                r.kind === "allow" ? "bg-green-900 text-green-200" : "bg-red-900 text-red-200"
              }`}
            >
              {r.kind}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {r.title || "(無題)"}
                {r.builtin === true && <span className="ml-2 text-[10px] text-subtle">既定</span>}
              </div>
              <div className="text-xs text-subtle whitespace-pre-wrap break-words">{r.description}</div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button className="text-xs underline" onClick={() => toggle(r)}>
                {r.enabled ? "無効化" : "有効化"}
              </button>
              {r.builtin !== true && (
                <button className="text-xs underline text-red-400" onClick={() => remove(r)}>
                  削除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="border border-border rounded-md p-3 flex flex-col gap-2">
        <div className="text-xs text-subtle">ルールを追加</div>
        <div className="flex gap-2 items-center">
          <select
            className="foundation-form"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as "allow" | "block" })}
          >
            <option value="block">block (遮断)</option>
            <option value="allow">allow (許可)</option>
          </select>
          <input
            className="foundation-form flex-1"
            placeholder="タイトル"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <textarea
          className="foundation-form"
          rows={2}
          placeholder="ガードに渡す自然文ルール (例: 認証情報を含むファイルに触れる依頼は拒否する)"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <button className="self-start text-sm px-3 py-1 rounded-md bg-accent text-black" onClick={add}>
          追加
        </button>
      </div>
    </section>
  );
}

// ─── 子会社管理 ──────────────────────────────────────────────────────

const EMPTY_FORM: SubsidiaryInput = {
  name: "",
  display_name: "",
  description: "",
  platform: "discord",
  enabled: false,
  guild_id: "",
  application_id: "",
  channel_id: "",
  bot_token: "",
  guard_model: "sonnet",
  guard_scope: "",
  home_cwd: "",
  daily_token_budget: 0,
};

function SubsidiariesSection() {
  const [subs, setSubs] = useState<SubsidiarySummary[]>([]);
  const [templates, setTemplates] = useState<DelegationTemplateLite[]>([]);
  const [form, setForm] = useState<SubsidiaryInput>(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    delegations: SubsidiaryDelegation[];
    locks: SubsidiaryLock[];
    requests: SubsidiaryRequest[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.subsidiariesList().then((r) => setSubs(r.subsidiaries)).catch((e) => setErr(String(e)));
    api.delegationTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const openDetail = async (id: string) => {
    setEditId(id);
    const r = await api.subsidiaryGet(id);
    setForm({
      name: r.subsidiary.name,
      display_name: r.subsidiary.display_name,
      description: r.subsidiary.description,
      platform: r.subsidiary.platform,
      enabled: r.subsidiary.enabled,
      guild_id: r.subsidiary.guild_id ?? "",
      application_id: r.subsidiary.application_id ?? "",
      channel_id: r.subsidiary.channel_id ?? "",
      bot_token: "",
      guard_model: r.subsidiary.guard_model,
      guard_scope: r.subsidiary.guard_scope,
      home_cwd: r.subsidiary.home_cwd ?? "",
      daily_token_budget: r.subsidiary.daily_token_budget ?? 0,
    });
    setDetail({ delegations: r.delegations, locks: r.locks, requests: r.requests });
  };

  const save = async () => {
    setErr(null);
    try {
      if (editId) {
        // bot_token は空なら据え置き (送らない)。
        const body: Partial<SubsidiaryInput> = { ...form };
        delete body.name;
        if (!form.bot_token) delete body.bot_token;
        await api.subsidiaryUpdate(editId, body);
      } else {
        await api.subsidiaryCreate(form);
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      setDetail(null);
      load();
    } catch (e) {
      setErr(String(e));
    }
  };

  const lifecycle = async (id: string, action: "start" | "stop" | "restart") => {
    const fn = action === "start" ? api.subsidiaryStart : action === "stop" ? api.subsidiaryStop : api.subsidiaryRestart;
    const r = await fn(id);
    if (!r.ok) setErr(`${action} 失敗: ${r.status} ${r.error ?? ""}`);
    load();
  };

  const toggleDelegation = async (callName: string) => {
    if (!editId || !detail) return;
    const has = detail.delegations.some((d) => d.call_name === callName);
    const next = has
      ? detail.delegations.filter((d) => d.call_name !== callName)
      : [...detail.delegations, { subsidiary_id: editId, call_name: callName, is_default: detail.delegations.length === 0 ? 1 : 0 }];
    await api.subsidiarySetDelegations(
      editId,
      next.map((d) => ({ call_name: d.call_name, is_default: d.is_default === 1 })),
    );
    openDetail(editId);
  };

  const setDefault = async (callName: string) => {
    if (!editId || !detail) return;
    await api.subsidiarySetDelegations(
      editId,
      detail.delegations.map((d) => ({ call_name: d.call_name, is_default: d.call_name === callName })),
    );
    openDetail(editId);
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">子会社 (出張先 Delegation)</h2>
      <p className="text-subtle text-xs mb-3">
        別の Discord/Slack サーバに出張する子会社。 専用 Bot が受付チャンネルの修正依頼を受け、
        Sonnet ガードを通してから専用 delegation を起動する。 セッション/コスト/状態カードは子会社単位で表示。
      </p>
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}

      <div className="flex flex-col gap-2 mb-5">
        {subs.map((s) => (
          <div key={s.id} className="border border-border rounded-md p-2 flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${s.running ? "bg-green-400" : "bg-subtle"}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {s.display_name || s.name} <span className="text-subtle text-xs">/ {s.platform}</span>
                {!s.enabled && <span className="ml-2 text-[10px] text-subtle">無効</span>}
              </div>
              <div className="text-xs text-subtle truncate">
                guild={s.guild_id ?? "-"} · 受付={s.channel_id ?? "-"} · token={s.bot_token_set ? "✓" : "✗"} · lock={s.lock_count ?? 0}
                {" · "}
                <span className={s.budget_blocked ? "text-red-400" : ""}>
                  {s.budget_blocked ? "💸 " : ""}予算 {fmtTokens(s.usage_today_tokens ?? 0)}/{s.daily_token_budget ? fmtTokens(s.daily_token_budget) : "∞"}
                </span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0 text-xs">
              <button className="underline" onClick={() => openDetail(s.id)}>編集</button>
              <button className="underline" onClick={() => lifecycle(s.id, s.running ? "restart" : "start")}>
                {s.running ? "再起動" : "起動"}
              </button>
              {s.running && <button className="underline" onClick={() => lifecycle(s.id, "stop")}>停止</button>}
            </div>
          </div>
        ))}
        {subs.length === 0 && <div className="text-subtle text-xs">子会社は未登録です。</div>}
      </div>

      <div className="border border-border rounded-md p-3 flex flex-col gap-2">
        <div className="text-sm font-medium">{editId ? "子会社を編集" : "子会社を追加"}</div>
        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="name (slug)" value={form.name ?? ""} disabled={!!editId} onChange={(v) => setForm({ ...form, name: v })} />
          <LabeledInput label="表示名" value={form.display_name ?? ""} onChange={(v) => setForm({ ...form, display_name: v })} />
          <div className="flex flex-col">
            <span className="text-[10px] text-subtle">platform</span>
            <select className="foundation-form" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as "discord" | "slack" })}>
              <option value="discord">discord</option>
              <option value="slack">slack</option>
            </select>
          </div>
          <LabeledInput label="guild_id / team" value={form.guild_id ?? ""} onChange={(v) => setForm({ ...form, guild_id: v })} />
          <LabeledInput label="application_id (任意)" value={form.application_id ?? ""} onChange={(v) => setForm({ ...form, application_id: v })} />
          <LabeledInput label="受付チャンネル id" value={form.channel_id ?? ""} onChange={(v) => setForm({ ...form, channel_id: v })} />
          <LabeledInput label={`bot token ${editId ? "(空=据え置き)" : ""}`} value={form.bot_token ?? ""} onChange={(v) => setForm({ ...form, bot_token: v })} type="password" />
          <LabeledInput label="guard model" value={form.guard_model ?? ""} onChange={(v) => setForm({ ...form, guard_model: v })} />
          <LabeledInput label="home_cwd (delegation 起点)" value={form.home_cwd ?? ""} onChange={(v) => setForm({ ...form, home_cwd: v })} />
          <label className="flex flex-col">
            <span className="text-[10px] text-subtle">日次トークン予算 (0 = 無制限)</span>
            <input
              className="foundation-form"
              type="number"
              min={0}
              step={10000}
              value={form.daily_token_budget ?? 0}
              onChange={(e) => setForm({ ...form, daily_token_budget: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
          </label>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-subtle">guard_scope (この子会社が許可する作業の自然文)</span>
          <textarea className="foundation-form" rows={2} value={form.guard_scope ?? ""} onChange={(e) => setForm({ ...form, guard_scope: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          有効化 (boot 時に Bot を起動)
        </label>

        {editId && detail && (
          <div className="border-t border-border pt-2 mt-1">
            <div className="text-xs text-subtle mb-1">許可 delegation (チェック=許可 / ★=既定)</div>
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => {
                const sel = detail.delegations.find((d) => d.call_name === t.call_name);
                return (
                  <span key={t.call_name} className={`text-xs border border-border rounded px-2 py-1 flex items-center gap-1 ${sel ? "bg-surface" : "opacity-60"}`}>
                    <input type="checkbox" checked={!!sel} onChange={() => toggleDelegation(t.call_name)} />
                    {t.call_name}
                    {sel && (
                      <button className={sel.is_default === 1 ? "text-yellow-400" : "text-subtle"} title="既定にする" onClick={() => setDefault(t.call_name)}>★</button>
                    )}
                  </span>
                );
              })}
            </div>

            {detail.locks.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-subtle mb-1">ロック中ユーザ</div>
                {detail.locks.map((l) => (
                  <div key={l.id} className="text-xs flex items-center gap-2">
                    <span className="text-red-300">🔒 {l.user_label || l.platform_user_id}</span>
                    <span className="text-subtle truncate">{l.reason}</span>
                    <button className="underline" onClick={async () => { await api.subsidiaryUnlock(editId!, l.platform, l.platform_user_id); openDetail(editId!); }}>解除</button>
                  </div>
                ))}
              </div>
            )}

            {detail.requests.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-subtle mb-1">最近の依頼 (監査)</div>
                <div className="flex flex-col gap-1 max-h-48 overflow-auto">
                  {detail.requests.map((r) => (
                    <div key={r.id} className="text-xs border border-border rounded px-2 py-1">
                      <span className={r.decision === "allow" ? "text-green-300" : "text-red-300"}>{r.decision}</span>
                      {r.locked === 1 && <span className="text-red-400"> 🔒</span>}
                      {" "}<span className="text-subtle">{r.user_label}</span> · {fmtTs(Math.floor(r.created_at / 1000))}
                      <div className="text-subtle truncate">{r.instruction}</div>
                      <div className="text-subtle">{r.reason} {r.violations_json !== "[]" ? r.violations_json : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button className="text-sm px-3 py-1 rounded-md bg-accent text-black" onClick={save}>
            {editId ? "保存" : "作成"}
          </button>
          {editId && (
            <>
              <button className="text-sm px-3 py-1 rounded-md border border-border" onClick={() => { setEditId(null); setForm(EMPTY_FORM); setDetail(null); }}>
                新規に戻す
              </button>
              <button
                className="text-sm px-3 py-1 rounded-md border border-red-700 text-red-300"
                onClick={async () => { if (confirm("削除しますか?")) { await api.subsidiaryDelete(editId); setEditId(null); setForm(EMPTY_FORM); setDetail(null); load(); } }}
              >
                削除
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** トークン数を人が読みやすい桁 (1,234k / 1,234) に整形する。 */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
  return n.toLocaleString("en-US");
}

function LabeledInput(props: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; type?: string }) {
  return (
    <label className="flex flex-col">
      <span className="text-[10px] text-subtle">{props.label}</span>
      <input
        className="foundation-form"
        type={props.type ?? "text"}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
