import { useEffect, useState } from "react";

type TeamSettings = {
  revisor_lane?: "local" | "github";
  worktree?: "allowed" | "repo-root-only";
  visibility?: "public" | "private";
  pr_rules?: { base: string; push: "revisor" };
  test_policy?: "confirm-queue" | "custos-unity";
  vibes_defaults?: { claim_sec: number };
};
type Team = { id: string; name: string; slug: string; settings: TeamSettings; rules_text: string; repos: string[] };

export function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [draft, setDraft] = useState<Team | null>(null);
  useEffect(() => { void fetch("/v1/teams").then((r) => r.json()).then((v) => setTeams(v.teams ?? [])); }, []);
  const choose = (team: Team) => { setSelected(team); setDraft(structuredClone(team)); };
  const save = async () => {
    if (!selected || !draft) return;
    const response = await fetch(`/v1/teams/${selected.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: draft.name, repos: draft.repos, rules_text: draft.rules_text, settings: draft.settings }),
    });
    if (!response.ok) return;
    const updated = { ...draft };
    setSelected(updated);
    setTeams((current) => current.map((team) => team.id === updated.id ? updated : team));
  };
  const setSetting = <K extends keyof TeamSettings>(key: K, value: TeamSettings[K]) => {
    setDraft((current) => current ? { ...current, settings: { ...current.settings, [key]: value } } : current);
  };
  return <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
    <section><h1 className="mb-3 text-xl font-semibold">Teams</h1>{teams.map((team) => <button key={team.id} className="mb-2 block w-full rounded border border-border p-3 text-left hover:bg-muted" onClick={() => choose(team)}><strong>{team.name}</strong><div className="text-xs text-subtle">{team.repos.length} repositories</div></button>)}</section>
    <section>{draft && <><h2 className="text-lg font-semibold">{draft.name}</h2><div className="mt-4 grid max-w-3xl gap-3">
      <label>Name<input className="block w-full rounded border border-border bg-surface p-2" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>Repositories (one per line)<textarea className="block min-h-24 w-full rounded border border-border bg-surface p-2" value={draft.repos.join("\n")} onChange={(e) => setDraft({ ...draft, repos: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean) })} /></label>
      <label>Revisor lane<select className="block w-full rounded border border-border bg-surface p-2" value={draft.settings.revisor_lane ?? "local"} onChange={(e) => setSetting("revisor_lane", e.target.value as TeamSettings["revisor_lane"])}><option value="local">Local</option><option value="github">GitHub</option></select></label>
      <label>Worktree policy<select className="block w-full rounded border border-border bg-surface p-2" value={draft.settings.worktree ?? "allowed"} onChange={(e) => setSetting("worktree", e.target.value as TeamSettings["worktree"])}><option value="allowed">Allowed</option><option value="repo-root-only">Repository root only</option></select></label>
      <label>Visibility<select className="block w-full rounded border border-border bg-surface p-2" value={draft.settings.visibility ?? "private"} onChange={(e) => setSetting("visibility", e.target.value as TeamSettings["visibility"])}><option value="private">Private</option><option value="public">Public</option></select></label>
      <label>Natural-language rules<textarea className="block min-h-48 w-full rounded border border-border bg-surface p-2" value={draft.rules_text} onChange={(e) => setDraft({ ...draft, rules_text: e.target.value })} /></label>
      <button className="justify-self-start rounded bg-accent px-4 py-2 text-white" onClick={() => void save()}>Save team</button>
    </div></>}</section>
  </div>;
}
