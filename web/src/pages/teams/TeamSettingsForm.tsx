/** チーム詳細タブ「設定」。 name / repos の基本情報編集 (旧 Teams ページの簡易エディタ由来)。 */

import { useEffect, useState } from "react";
import { api, type Team } from "../../api.js";
import { runMutation } from "../../lib/mutation.js";
import { parseRepoLines } from "./model.js";

export function TeamSettingsForm({ team, onSaved }: { team: Team; onSaved: (team: Team) => void }) {
  const [name, setName] = useState(team.name);
  const [reposText, setReposText] = useState(team.repos.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(team.name);
    setReposText(team.repos.join("\n"));
  }, [team]);

  const save = () => void runMutation({
    setBusy,
    setError,
    action: () => api.teamUpdate(team.id, { name, repos: parseRepoLines(reposText) }),
    onSuccess: (result) => onSaved(result.team),
  });

  return (
    <div className="grid max-w-3xl gap-3">
      {error && <div className="text-danger text-sm">{error}</div>}
      <label className="text-sm">Name
        <input className="foundation-form block w-full text-sm" value={name} disabled={busy}
          onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="text-sm">Repositories (one per line, repo origin)
        <textarea className="foundation-form block min-h-24 w-full text-sm" value={reposText} disabled={busy}
          onChange={(e) => setReposText(e.target.value)} />
      </label>
      <button className="justify-self-start bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        disabled={busy || !name.trim()} onClick={save}>
        保存
      </button>
    </div>
  );
}
