/**
 * チーム詳細タブ「ルールエディタ」 (teams.md §4.1)。
 * A 層 = typed settings (機械で強制) のフォーム、 B 層 = 自然文ルール:
 * チームルール文書 (teams.rules_text、 Lictor 注入用) と harness_rules の
 * チームスコープ一覧 (HarnessRulesPanel 流用)。
 */

import { useEffect, useState } from "react";
import { api, type Team, type TeamSettings } from "../../api.js";
import { runMutation } from "../../lib/mutation.js";
import { HarnessRulesPanel } from "../manuals/HarnessRulesPanel.js";

interface RulesDraft {
  settings: TeamSettings;
  rules_text: string;
}

function toDraft(team: Team): RulesDraft {
  return { settings: structuredClone(team.settings), rules_text: team.rules_text };
}

export function TeamRulesEditor({ team, onSaved }: { team: Team; onSaved: (team: Team) => void }) {
  const [draft, setDraft] = useState<RulesDraft>(() => toDraft(team));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(toDraft(team)); }, [team]);

  const setSetting = <K extends keyof TeamSettings>(key: K, value: TeamSettings[K] | undefined) => {
    setDraft((current) => {
      const settings = { ...current.settings };
      if (value === undefined) delete settings[key];
      else settings[key] = value;
      return { ...current, settings };
    });
  };

  const save = () => void runMutation({
    setBusy,
    setError,
    action: () => api.teamUpdate(team.id, { settings: draft.settings, rules_text: draft.rules_text }),
    onSuccess: (result) => onSaved(result.team),
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">A 層 — typed settings (機械で強制)</h3>
        {error && <div className="text-danger text-sm">{error}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Revisor lane
            <select className="foundation-form block w-full text-sm" disabled={busy}
              value={draft.settings.revisor_lane ?? "local"}
              onChange={(e) => setSetting("revisor_lane", e.target.value as TeamSettings["revisor_lane"])}>
              <option value="local">Local</option>
              <option value="github">GitHub</option>
            </select>
          </label>
          <label className="text-sm">Worktree policy
            <select className="foundation-form block w-full text-sm" disabled={busy}
              value={draft.settings.worktree ?? "allowed"}
              onChange={(e) => setSetting("worktree", e.target.value as TeamSettings["worktree"])}>
              <option value="allowed">Allowed</option>
              <option value="repo-root-only">Repository root only</option>
            </select>
          </label>
          <label className="text-sm">Visibility
            <select className="foundation-form block w-full text-sm" disabled={busy}
              value={draft.settings.visibility ?? "private"}
              onChange={(e) => setSetting("visibility", e.target.value as TeamSettings["visibility"])}>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label className="text-sm">Test policy
            <select className="foundation-form block w-full text-sm" disabled={busy}
              value={draft.settings.test_policy ?? ""}
              onChange={(e) => setSetting("test_policy", (e.target.value || undefined) as TeamSettings["test_policy"])}>
              <option value="">未設定 (既定)</option>
              <option value="confirm-queue">confirm-queue</option>
              <option value="custos-unity">custos-unity</option>
            </select>
          </label>
          <label className="text-sm">PR base branch (push は revisor 固定)
            <input className="foundation-form block w-full text-sm" disabled={busy}
              placeholder="例: develop (空 = 未設定)"
              value={draft.settings.pr_rules?.base ?? ""}
              onChange={(e) => {
                const base = e.target.value.trim();
                setSetting("pr_rules", base ? { base, push: "revisor" } : undefined);
              }} />
          </label>
          <label className="text-sm">Vibes claim (秒)
            <input className="foundation-form block w-full text-sm" type="number" min={1} disabled={busy}
              placeholder="空 = 未設定"
              value={draft.settings.vibes_defaults?.claim_sec ?? ""}
              onChange={(e) => {
                const seconds = Number(e.target.value);
                setSetting(
                  "vibes_defaults",
                  Number.isInteger(seconds) && seconds > 0 ? { claim_sec: seconds } : undefined,
                );
              }} />
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">B 層 — チームルール文書 (spawn 時に Lictor へ注入)</h3>
        <textarea className="foundation-form block min-h-40 w-full text-sm" disabled={busy}
          placeholder="このチームで作業するセッションへ渡す自然文ルール"
          value={draft.rules_text}
          onChange={(e) => setDraft({ ...draft, rules_text: e.target.value })} />
        <button className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          disabled={busy} onClick={save}>
          設定とルール文書を保存
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">B 層 — ハーネスルール (ガードプロンプトに列挙)</h3>
        <HarnessRulesPanel teamId={team.id} />
      </section>
    </div>
  );
}
