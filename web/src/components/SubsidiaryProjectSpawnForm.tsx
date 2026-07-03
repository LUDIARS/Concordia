import { useState } from "react";
import { api } from "../api.js";

type Provider = "claude" | "codex";

export function SubsidiaryProjectSpawnForm({
  subsidiaryId,
  className = "",
}: {
  subsidiaryId: string;
  className?: string;
}) {
  const [project, setProject] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function spawn() {
    const name = project.trim();
    if (!name || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.adminSpawn({
        provider,
        subsidiary_id: subsidiaryId,
        project: name,
      });
      setResult({ ok: !!r.ok, text: r.ok ? `spawned ${name} (pid ${r.pid ?? "?"})` : (r.error ?? "spawn failed") });
      if (r.ok) setProject("");
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <input
          className="foundation-form flex-1 min-w-0 text-xs"
          placeholder="project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void spawn(); }}
        />
        <select
          className="foundation-form text-xs"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          disabled={busy}
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <button
          type="button"
          onClick={() => void spawn()}
          disabled={busy || !project.trim()}
          className="bg-accent text-bg px-2 py-1 rounded text-xs font-medium disabled:opacity-50 shrink-0"
        >
          {busy ? "Spawning..." : "Spawn"}
        </button>
      </div>
      {result && (
        <div className={`text-[11px] mt-1 ${result.ok ? "text-ok" : "text-danger"}`}>
          {result.text}
        </div>
      )}
    </div>
  );
}
