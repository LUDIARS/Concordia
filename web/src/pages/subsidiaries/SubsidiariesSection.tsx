import { useEffect, useState, useCallback } from "react";
import {
  api,
  fmtTs,
  type HarnessRule,
  type HarnessAuditRow,
  type HarnessAuditDecision,
  type HarnessAuditEvent,
  type SubsidiarySummary,
  type SubsidiaryInput,
  type SubsidiaryDelegation,
  type SubsidiaryLock,
  type SubsidiaryRequest,
  type DelegationTemplateLite,
  type Team,
} from "../../api.js";
import { SubsidiaryProjectSpawnForm } from "../../components/SubsidiaryProjectSpawnForm.js";
import { SubsidiaryProjectsField } from "./SubsidiaryProjectsField.js";
import { runMutation } from "../../lib/mutation.js";

// ─── 子会社管理 ──────────────────────────────────────────────────────

const EMPTY_FORM: SubsidiaryInput = {
  name: "",
  display_name: "",
  description: "",
  platform: "discord",
  mode: "subsidiary",
  enabled: false,
  guild_id: "",
  channel_id: "",
  guard_model: "sonnet",
  guard_scope: "",
  daily_token_budget: 0,
  default_team_id: null,
  projects: [],
};

/** @implements spec/feature/subsidiary-delegation.md §3.4 — subsidiary project-scope editing. */
export function SubsidiariesSection() {
  const [subs, setSubs] = useState<SubsidiarySummary[]>([]);
  const [templates, setTemplates] = useState<DelegationTemplateLite[]>([]);
  const [form, setForm] = useState<SubsidiaryInput>(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    delegations: SubsidiaryDelegation[];
    locks: SubsidiaryLock[];
    requests: SubsidiaryRequest[];
    teams: Team[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(() => {
    api.subsidiariesList().then((r) => setSubs(r.subsidiaries)).catch((e) => setErr(String(e)));
    api.delegationTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const openDetail = async (id: string) => {
    await runMutation({
      setBusy: (busy) => setBusyAction(busy ? `detail:${id}` : null),
      setError: setErr,
      action: () => api.subsidiaryGet(id),
      onSuccess: (r) => {
    setEditId(id);
    setForm({
      name: r.subsidiary.name,
      display_name: r.subsidiary.display_name,
      description: r.subsidiary.description,
      platform: r.subsidiary.platform,
      mode: r.subsidiary.mode,
      enabled: r.subsidiary.enabled,
      guild_id: r.subsidiary.guild_id ?? "",
      channel_id: r.subsidiary.channel_id ?? "",
      guard_model: r.subsidiary.guard_model,
      guard_scope: r.subsidiary.guard_scope,
      daily_token_budget: r.subsidiary.daily_token_budget ?? 0,
      default_team_id: r.subsidiary.default_team_id ?? null,
      projects: r.subsidiary.projects ?? [],
    });
    setDetail({ delegations: r.delegations, locks: r.locks, requests: r.requests, teams: r.teams });
      },
    });
  };

  const save = async () => {
    setErr(null);
    try {
      if (editId) {
        const body: Partial<SubsidiaryInput> = { ...form };
        delete body.name;
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
    await runMutation({
      setBusy: (busy) => setBusyAction(busy ? `${action}:${id}` : null),
      setError: setErr,
      errorPrefix: `${action} 失敗: `,
      action: async () => {
        const r = await fn(id);
        if (!r.ok) throw new Error(`${r.status} ${r.error ?? ""}`);
        return r;
      },
      onSuccess: load,
    });
  };

  const deleteSubsidiary = async () => {
    if (!editId) return;
    await runMutation({
      confirmMessage: "削除しますか? 所有チームがある子会社は削除できません。運用終了は無効化してください。",
      setBusy: (busy) => setBusyAction(busy ? `delete:${editId}` : null),
      setError: setErr,
      errorPrefix: "削除失敗: ",
      action: () => api.subsidiaryDelete(editId),
      onSuccess: () => {
        setEditId(null);
        setForm(EMPTY_FORM);
        setDetail(null);
        load();
      },
    });
  };

  // ── 所有 delegation 操作 (clone / 既定 / JSON コピー / 貼付 / 削除) ──
  const [cloneFrom, setCloneFrom] = useState("");
  const [pasteJson, setPasteJson] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");

  const createSubsidiaryTeam = async () => {
    if (!editId || !teamName.trim() || !teamSlug.trim()) return;
    await runMutation({
      setBusy: (busy) => setBusyAction(busy ? `team-create:${editId}` : null),
      setError: setErr,
      action: () => api.teamCreate({
        name: teamName.trim(),
        slug: teamSlug.trim(),
        subsidiary_id: editId,
      }),
      onSuccess: async (result) => {
        setTeamName("");
        setTeamSlug("");
        // 最初のチームは直ちに既定にし、子会社タスクが team 無しで起動する隙間を作らない。
        if (!form.default_team_id) {
          await api.subsidiaryUpdate(editId, { default_team_id: result.team.id });
        }
        await openDetail(editId);
      },
    });
  };

  const cloneTemplate = async () => {
    if (!editId || !cloneFrom) return;
    try {
      await api.subsidiaryDelegationClone(editId, { call_name: cloneFrom, is_default: (detail?.delegations.length ?? 0) === 0 });
      setCloneFrom("");
      openDetail(editId);
    } catch (e) { setErr(String(e)); }
  };

  const setDefault = async (callName: string) => {
    if (!editId) return;
    await runMutation({
      setBusy: (busy) => setBusyAction(busy ? `default:${callName}` : null),
      setError: setErr,
      action: () => api.subsidiaryDelegationSetDefault(editId, callName),
      onSuccess: () => openDetail(editId),
    });
  };

  const removeOwned = async (callName: string) => {
    if (!editId) return;
    await runMutation({
      confirmMessage: `delegation「${callName}」を削除しますか?`,
      setBusy: (busy) => setBusyAction(busy ? `remove:${callName}` : null),
      setError: setErr,
      action: () => api.subsidiaryDelegationDelete(editId, callName),
      onSuccess: () => openDetail(editId),
    });
  };

  const copyOwnedJson = async (callName: string) => {
    if (!editId) return;
    try {
      const r = await api.subsidiaryDelegationExport(editId, callName);
      await navigator.clipboard.writeText(JSON.stringify(r.delegation, null, 2));
      setErr(null);
    } catch (e) { setErr(`JSON コピー失敗: ${String(e)}`); }
  };

  const pasteOwned = async () => {
    if (!editId) return;
    let obj: { call_name?: string } & Record<string, unknown>;
    try { obj = JSON.parse(pasteJson); } catch { setErr("貼付 JSON が不正です"); return; }
    const callName = (obj.call_name ?? "").toString().trim();
    if (!callName) { setErr("貼付 JSON に call_name がありません"); return; }
    try {
      await api.subsidiaryDelegationUpsert(editId, callName, obj as never);
      setPasteJson("");
      openDetail(editId);
    } catch (e) { setErr(`貼付で作成/更新に失敗: ${String(e)}`); }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">子会社 (出張先 Delegation)</h2>
      <p className="text-subtle text-xs mb-3">
        別の Discord/Slack サーバに出張する子会社。 専用 Bot が受付チャンネルの修正依頼を受け、
        Sonnet ガードを通してから所有 delegation を起動する。 セッション/コスト/状態カードは子会社単位で表示。
        <br />
        <span className="text-[11px]">
          ※ Bot の application_id / token は<b>本社と同じものを共有</b> (同一 Bot を出張先 guild に招待)。
          物理 Gateway 接続も token 単位で共有し、子会社固有なのは guild_id と論理 runtime。
          受付チャンネルは Bot 起動時に<b>自動作成</b>される (手動指定は override)。
        </span>
      </p>
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}

      <div className="flex flex-col gap-2 mb-5">
        {subs.map((s) => (
          <div key={s.id} className="border border-border rounded-md p-2 flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${s.mode === "desk" ? (s.enabled ? "bg-blue-400" : "bg-subtle") : (s.running ? "bg-green-400" : "bg-subtle")}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {s.display_name || s.name} <span className="text-subtle text-xs">/ {s.platform}</span>
                <span className="ml-2 text-[10px] text-subtle">{s.mode === "desk" ? "本社内窓口" : "子会社"}</span>
                {!s.enabled && <span className="ml-2 text-[10px] text-subtle">無効</span>}
              </div>
              <div className="text-xs text-subtle truncate">
                {s.mode === "desk" ? "guild=本社" : `guild=${s.guild_id ?? "-"}`} · 受付={s.channel_id ?? "auto"} · deleg={(s.delegations?.length ?? 0)} · lock={s.lock_count ?? 0}
                {" · "}
                <span className={s.budget_blocked ? "text-red-400" : ""}>
                  {s.budget_blocked ? "💸 " : ""}予算 {fmtTokens(s.usage_today_tokens ?? 0)}/{s.daily_token_budget ? fmtTokens(s.daily_token_budget) : "∞"}
                </span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0 text-xs">
              <button className="underline" disabled={busyAction !== null} onClick={() => openDetail(s.id)}>編集</button>
              {/* desk は専用 Bot を持たない (本社 Bot が受付する) ので起動/停止は出さない。 */}
              {s.mode !== "desk" && (
                <>
                  <button className="underline" disabled={busyAction !== null} onClick={() => lifecycle(s.id, s.running ? "restart" : "start")}>
                    {s.running ? "再起動" : "起動"}
                  </button>
                  {s.running && <button className="underline" disabled={busyAction !== null} onClick={() => lifecycle(s.id, "stop")}>停止</button>}
                </>
              )}
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
          <LabeledInput label="guild_id / team (出張先)" value={form.guild_id ?? ""} onChange={(v) => setForm({ ...form, guild_id: v })} />
          <LabeledInput label="受付チャンネル id (空=自動作成)" value={form.channel_id ?? ""} onChange={(v) => setForm({ ...form, channel_id: v })} />
          <LabeledInput label="guard model" value={form.guard_model ?? ""} onChange={(v) => setForm({ ...form, guard_model: v })} />
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
        <SubsidiaryProjectsField
          value={form.projects ?? []}
          onChange={(projects) => setForm({ ...form, projects })}
        />
        <div className="flex flex-col">
          <span className="text-[10px] text-subtle">guard_scope (この子会社が許可する作業の自然文)</span>
          <textarea className="foundation-form" rows={2} value={form.guard_scope ?? ""} onChange={(e) => setForm({ ...form, guard_scope: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.mode === "desk"}
            onChange={(e) => setForm({ ...form, mode: e.target.checked ? "desk" : "subsidiary" })}
          />
          本社内の窓口として作る (専用 Bot を立てず、 本社サーバに「タスク依頼」チャンネルを 1 本作る)
        </label>
        <p className="text-[10px] text-subtle -mt-1">
          子会社が要るか迷うケースはこちら。 ガード・ハーネスルール・ロック・監査・日次予算・所有 delegation は
          子会社と同じ仕組みが効く。 違いは <b>出張先 guild へ Bot を接続しない</b>ことだけ (guild_id は不要)。
          反映には本社 Bot の再起動が要る。
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {form.mode === "desk" ? "有効化 (本社 Bot が受付を開く)" : "有効化 (boot 時に Bot を起動)"}
        </label>

        {editId && (
          <div className="border-t border-border pt-2 mt-1">
            <div className="text-xs text-subtle mb-1">プロジェクト指定 spawn</div>
            <SubsidiaryProjectSpawnForm subsidiaryId={editId} />
          </div>
        )}

        {editId && detail && (
          <div className="border-t border-border pt-2 mt-1">
            <div className="text-xs text-subtle mb-1">子会社チーム (最初のチームは自動で既定)</div>
            <div className="flex flex-col gap-1 mb-2">
              {detail.teams.map((team) => (
                <div key={team.id} className="text-xs border border-border rounded px-2 py-1 flex items-center gap-2">
                  <span className="font-medium">{team.name}</span>
                  <span className="text-subtle">({team.slug})</span>
                  {team.suspended && <span className="text-yellow-400">一時停止</span>}
                  {form.default_team_id === team.id && <span className="text-green-300">既定</span>}
                </div>
              ))}
              {detail.teams.length === 0 && <div className="text-subtle text-xs">子会社チームは未登録です。</div>}
            </div>
            <label className="flex flex-col mb-2">
              <span className="text-[10px] text-subtle">既定チーム (子会社 delegation / TaskWorkflow の所属先)</span>
              <select
                className="foundation-form text-xs"
                value={form.default_team_id ?? ""}
                onChange={(e) => setForm({ ...form, default_team_id: e.target.value || null })}
              >
                <option value="">未指定</option>
                {detail.teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.slug})</option>)}
              </select>
            </label>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-3">
              <LabeledInput label="新規チーム名" value={teamName} onChange={setTeamName} />
              <LabeledInput label="slug" value={teamSlug} onChange={setTeamSlug} />
              <button
                className="self-end text-xs px-2 py-1 rounded-md border border-border"
                disabled={busyAction !== null || !teamName.trim() || !teamSlug.trim()}
                onClick={createSubsidiaryTeam}
              >
                チーム作成
              </button>
            </div>

            <div className="border-t border-border pt-2 text-xs text-subtle mb-1">所有 delegation (子会社が複製所有。 cwd / project はここで管理 / ★=既定)</div>
            <div className="flex flex-col gap-1 mb-2">
              {detail.delegations.map((d) => (
                <div key={d.call_name} className="text-xs border border-border rounded px-2 py-1 flex items-center gap-2">
                  <button disabled={busyAction !== null} className={d.is_default ? "text-yellow-400" : "text-subtle"} title="既定にする" onClick={() => setDefault(d.call_name)}>★</button>
                  <span className="font-medium">{d.call_name}</span>
                  <span className="text-subtle truncate">{d.title}</span>
                  <span className="text-subtle whitespace-nowrap">{d.project ? `· ${d.project}` : ""}{d.default_cwd ? ` · ${d.default_cwd}` : ""}</span>
                  <span className="flex-1" />
                  <button className="underline shrink-0" title="可搬 JSON をクリップボードにコピー" onClick={() => copyOwnedJson(d.call_name)}>📋JSON</button>
                  <button disabled={busyAction !== null} className="underline text-red-400 shrink-0" onClick={() => removeOwned(d.call_name)}>削除</button>
                </div>
              ))}
              {detail.delegations.length === 0 && <div className="text-subtle text-xs">所有 delegation は未登録です。</div>}
            </div>
            <div className="flex items-center gap-2 mb-2">
              <select className="foundation-form text-xs" value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}>
                <option value="">グローバルテンプレから複製…</option>
                {templates.map((t) => (
                  <option key={t.call_name} value={t.call_name}>{t.call_name}{t.title ? ` — ${t.title}` : ""}</option>
                ))}
              </select>
              <button className="text-xs px-2 py-1 rounded-md border border-border" disabled={!cloneFrom} onClick={cloneTemplate}>複製</button>
            </div>
            <div className="flex flex-col gap-1 mb-1">
              <span className="text-[10px] text-subtle">JSON 貼付で追加/更新 (📋JSON でコピーした可搬 delegation を貼り付け)</span>
              <textarea
                className="foundation-form text-xs font-mono"
                rows={3}
                placeholder='{"call_name":"...","target_provider":"claude","default_cwd":"...","project":"..."}'
                value={pasteJson}
                onChange={(e) => setPasteJson(e.target.value)}
              />
              <button className="self-start text-xs px-2 py-1 rounded-md border border-border" disabled={!pasteJson.trim()} onClick={pasteOwned}>貼付で追加/更新</button>
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
                disabled={busyAction !== null}
                onClick={deleteSubsidiary}
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
