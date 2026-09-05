// RWF の「スキル割り当て」表 (設計 §10.2 C-10)。
// 行 = 絵文字 × スキル (GET /v1/skills/catalog の一覧) × mode × model。
// 保存先は既存の customWorkflows JSON (/v1/admin/reaction-skill-workflows)。
// 組み込み → スキルの移行は POST /v1/reaction-workflow/migrate-builtin。

import { useEffect, useState } from "react";

import { putJson } from "./common.js";

interface SkillRwfBinding {
  emoji: string[];
  action: string | null;
  args: string | null;
  mode: "inject" | "headless";
  model: string | null;
  cwd: string | null;
}

interface SkillOption {
  name: string;
  description: string;
  source: "skills" | "commands" | "user";
  rwf: SkillRwfBinding[];
}

interface SkillEntry {
  emoji: string;
  skill: string;
  args?: string;
  mode: "inject" | "headless";
  model?: string;
  cwd?: string;
  action?: string;
  label?: string;
}

interface SkillWorkflowsResponse {
  path: string;
  entries: SkillEntry[];
  skills: SkillOption[];
  scanned_at: number;
  notes: string[];
}

interface MigrateResponse {
  path: string;
  migrated: number;
  uncovered: string[];
  added: string[];
  notes: string[];
}

const MODEL_OPTIONS = ["", "opus", "sonnet", "haiku"];
const CWD_OPTIONS = ["", "repo", "memoria", "castra"];

const SOURCE_LABEL: Record<SkillOption["source"], string> = {
  skills: ".claude/skills",
  commands: ".claude/commands",
  user: "~/.claude/skills",
};

/** 空欄の新規行 (追加フォーム) の初期値。 */
const BLANK: SkillEntry = { emoji: "", skill: "", mode: "inject" };

export function ReactionSkillWorkflowsPanel({
  actionOptions,
}: {
  /** 既存の WorkflowAction 一覧 (権限判定に使う action を選ばせる)。 */
  actionOptions: string[];
}) {
  const [data, setData] = useState<SkillWorkflowsResponse | null>(null);
  const [draft, setDraft] = useState<SkillEntry>(BLANK);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrateResult, setMigrateResult] = useState<MigrateResponse | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const r = await fetch("/v1/admin/reaction-skill-workflows");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json() as SkillWorkflowsResponse);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function rescan() {
    setBusy("rescan"); setError(null);
    try {
      const r = await fetch("/v1/skills/refresh", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function save(entry: SkillEntry) {
    if (!entry.emoji.trim() || !entry.skill) return;
    setBusy(`save:${entry.emoji}`); setError(null);
    try {
      await putJson("/v1/admin/reaction-skill-workflows", {
        emoji: entry.emoji.trim(),
        skill: entry.skill,
        mode: entry.mode,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.action ? { action: entry.action } : {}),
      });
      setDraft(BLANK);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function remove(emoji: string) {
    setBusy(`rm:${emoji}`); setError(null);
    try {
      const r = await fetch(`/v1/admin/reaction-skill-workflows/${encodeURIComponent(emoji)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function migrate() {
    setBusy("migrate"); setError(null);
    try {
      const r = await fetch("/v1/reaction-workflow/migrate-builtin", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMigrateResult(await r.json() as MigrateResponse);
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const skills = data?.skills ?? [];
  const describe = (name: string) => skills.find((s) => s.name === name)?.description ?? "";

  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-3">
      <div>
        <div className="text-sm font-medium">スキル割り当て (絵文字 → スキル)</div>
        <div className="text-xs text-subtle mt-0.5">
          Castra の <code>.claude/skills</code> / <code>.claude/commands</code> にあるスキルを絵文字へ割り当てます。
          {" "}<code>inject</code> は稼働中セッションへ <code>/&lt;skill&gt;</code> を流し、
          {" "}<code>headless</code> は SKILL.md 本文をシステム文脈として <code>claude -p</code> に渡します
          (非 active セッションでは inject も headless へ落ちます)。
          保存先は <code>{data?.path ?? "custom-reaction-workflows.json"}</code>。
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <button
          type="button" disabled={busy === "rescan"} onClick={() => void rescan()}
          className="px-2 py-1 bg-muted border border-border rounded disabled:opacity-40"
        >スキル一覧を再走査</button>
        <button
          type="button" disabled={busy === "migrate"} onClick={() => void migrate()}
          className="px-2 py-1 bg-accent/15 border border-accent text-accent rounded disabled:opacity-40"
        >組み込み写像をスキルへ移行</button>
        <span className="text-subtle">スキル {skills.length} 件 / 割り当て {data?.entries.length ?? 0} 件</span>
      </div>

      {migrateResult && (
        <div className={`border rounded p-2 text-xs ${migrateResult.uncovered.length > 0 ? "border-danger bg-danger/10 text-danger" : "border-ok bg-ok/10 text-ok"}`}>
          <div className="font-semibold">移行結果: {migrateResult.migrated} 件を書き出しました</div>
          {migrateResult.uncovered.length > 0
            ? <div className="mt-1">スキル未割り当ての組み込み絵文字: {migrateResult.uncovered.join(" ")} — この絵文字は発火しません。</div>
            : <div className="mt-1">組み込み写像の取りこぼしはありません。</div>}
          {migrateResult.added.length > 0 && (
            <div className="mt-1">スキル側だけが宣言している絵文字: {migrateResult.added.join(" ")}</div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[640px]">
          <thead>
            <tr className="text-[11px] text-subtle border-b border-border">
              <th className="py-1 pr-2 font-medium">絵文字</th>
              <th className="py-1 pr-2 font-medium">スキル</th>
              <th className="py-1 pr-2 font-medium">引数</th>
              <th className="py-1 pr-2 font-medium">mode</th>
              <th className="py-1 pr-2 font-medium">model</th>
              <th className="py-1 pr-2 font-medium">cwd</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((entry) => (
              <tr key={entry.emoji} className="border-b border-border/50 align-top">
                <td className="py-1 pr-2 text-lg">{entry.emoji}</td>
                <td className="py-1 pr-2">
                  <div className="font-mono text-xs text-accent">{entry.skill}</div>
                  <div className="text-[11px] text-subtle">{describe(entry.skill) || "(一覧に無いスキル — headless では実行できません)"}</div>
                  {entry.action && <div className="text-[11px] text-subtle">action: {entry.action}</div>}
                </td>
                <td className="py-1 pr-2 text-xs">{entry.args ?? "—"}</td>
                <td className="py-1 pr-2 text-xs">{entry.mode}</td>
                <td className="py-1 pr-2 text-xs">{entry.model ?? "sonnet"}</td>
                <td className="py-1 pr-2 text-xs">{entry.cwd ?? "repo"}</td>
                <td className="py-1">
                  <button
                    disabled={busy === `rm:${entry.emoji}`}
                    onClick={() => void remove(entry.emoji)}
                    className="text-subtle hover:text-danger text-xs"
                  >削除</button>
                </td>
              </tr>
            ))}
            <tr className="align-top">
              <td className="py-1 pr-2">
                <input
                  type="text" value={draft.emoji}
                  onChange={(e) => setDraft({ ...draft, emoji: e.target.value })}
                  placeholder="🔥"
                  className="bg-muted border border-border rounded px-2 py-1 text-sm w-16"
                />
              </td>
              <td className="py-1 pr-2">
                <select
                  value={draft.skill}
                  onChange={(e) => {
                    const skill = e.target.value;
                    const binding = skills.find((s) => s.name === skill)?.rwf[0];
                    setDraft({
                      ...draft,
                      skill,
                      mode: binding?.mode ?? draft.mode,
                      model: binding?.model ?? draft.model,
                      cwd: binding?.cwd ?? draft.cwd,
                      args: binding?.args ?? draft.args,
                      action: binding?.action ?? draft.action,
                    });
                  }}
                  className="bg-muted border border-border rounded px-1.5 py-1 text-xs max-w-[220px]"
                >
                  <option value="">スキルを選ぶ…</option>
                  {skills.map((s) => (
                    <option key={`${s.source}:${s.name}`} value={s.name}>
                      {s.name} ({SOURCE_LABEL[s.source]})
                    </option>
                  ))}
                </select>
                {draft.skill && (
                  <div className="text-[11px] text-subtle mt-0.5 max-w-[240px]">{describe(draft.skill)}</div>
                )}
              </td>
              <td className="py-1 pr-2">
                <input
                  type="text" value={draft.args ?? ""}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                  placeholder="--report-only"
                  className="bg-muted border border-border rounded px-2 py-1 text-xs w-28"
                />
              </td>
              <td className="py-1 pr-2">
                <select
                  value={draft.mode}
                  onChange={(e) => setDraft({ ...draft, mode: e.target.value as SkillEntry["mode"] })}
                  className="bg-muted border border-border rounded px-1.5 py-1 text-xs"
                >
                  <option value="inject">inject</option>
                  <option value="headless">headless</option>
                </select>
              </td>
              <td className="py-1 pr-2">
                <select
                  value={draft.model ?? ""}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}
                  className="bg-muted border border-border rounded px-1.5 py-1 text-xs"
                >
                  {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m || "既定 (sonnet)"}</option>)}
                </select>
              </td>
              <td className="py-1 pr-2">
                <select
                  value={draft.cwd ?? ""}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value || undefined })}
                  className="bg-muted border border-border rounded px-1.5 py-1 text-xs"
                >
                  {CWD_OPTIONS.map((v) => <option key={v} value={v}>{v || "既定 (repo)"}</option>)}
                </select>
              </td>
              <td className="py-1">
                <button
                  disabled={!draft.emoji.trim() || !draft.skill || busy !== null}
                  onClick={() => void save(draft)}
                  className="px-2 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
                >追加 / 上書き</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-subtle">
        権限判定に使う action:
        <select
          value={draft.action ?? ""}
          onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
          className="ml-1 bg-muted border border-border rounded px-1.5 py-0.5"
        >
          <option value="">未指定 (組み込み写像から解決)</option>
          {actionOptions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {data && data.notes.length > 0 && (
        <ul className="text-[11px] text-subtle list-disc pl-4">
          {data.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      {error && <div className="text-danger text-xs">{error}</div>}
    </div>
  );
}
