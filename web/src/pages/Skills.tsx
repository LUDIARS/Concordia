import { useState } from "react";
import { api, fmtTs } from "../api.js";
import type { SkillSnapshot } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Skills() {
  const { data, error } = useLiveQuery(() => api.skillsList(), ["skill.snapshot"]);
  const [selected, setSelected] = useState<SkillSnapshot | null>(null);

  if (error) return <div className="text-danger">load error: {error.message}</div>;

  const skills = data?.skills ?? [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-semibold">Skills 監視</h1>
        <p className="text-subtle text-sm mt-1">
          各 repo の <code>.claude/skills/concordia/SKILL.md</code> を hook が監視.
          書き換えごとに snapshot + 解析 (poison / growth). セッションが skill を成長させたか、
          逆に汚染されたかを可視化します.
        </p>
      </header>

      {skills.length === 0 && (
        <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">
          まだ snapshot が登録されていません. 各 session の hook が起動時に POST します.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {skills.map((s) => (
          <SkillCard key={s.id} s={s} onClick={() => setSelected(s)} />
        ))}
      </div>

      {selected && <SkillDetail s={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function SkillCard({ s, onClick }: { s: SkillSnapshot; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-surface border border-border rounded p-3 hover:border-accent transition-colors"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="bg-muted px-2 py-0.5 rounded text-subtle">{s.skill_name}</span>
        <span className="ml-auto text-subtle">{fmtTs(s.ts)}</span>
      </div>
      <div className="mt-2 font-mono text-sm truncate">{s.repo_path}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <PoisonBadge score={s.poison_score} reasons={s.poison_reasons.length} />
        <GrowthBadge score={s.growth_score} notes={s.growth_notes.length} />
        <span className="ml-auto text-subtle font-mono">{s.size_bytes}B / {s.line_count}行</span>
      </div>
      {s.poison_reasons.length > 0 && (
        <div className="mt-2 text-[11px] text-warn truncate">
          ⚠ {s.poison_reasons.slice(0, 2).join(" / ")}
          {s.poison_reasons.length > 2 && ` (+${s.poison_reasons.length - 2})`}
        </div>
      )}
    </button>
  );
}

function PoisonBadge({ score, reasons }: { score: number; reasons: number }) {
  const color =
    score >= 0.6 ? "bg-danger/20 text-danger" :
    score >= 0.3 ? "bg-warn/20 text-warn" :
    "bg-ok/20 text-ok";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${color}`}>
      poison {Math.round(score * 100)}% ({reasons})
    </span>
  );
}

function GrowthBadge({ score, notes }: { score: number; notes: number }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent/20 text-accent">
      growth {Math.round(score * 100)}% ({notes})
    </span>
  );
}

function SkillDetail({ s, onClose }: { s: SkillSnapshot; onClose: () => void }) {
  const { data: hist } = useLiveQuery(
    () => api.skillsHistory(s.repo_path, s.skill_name),
    ["skill.snapshot"],
    `${s.repo_path}|${s.skill_name}`,
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-10 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded max-w-3xl w-full max-h-[85vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{s.skill_name}</h2>
          <span className="text-subtle text-xs ml-auto">{fmtTs(s.ts)}</span>
          <button onClick={onClose} className="ml-2 text-subtle hover:text-text">×</button>
        </div>
        <div className="mt-1 font-mono text-sm">{s.repo_path}</div>
        {s.repo_origin && <div className="text-xs text-subtle">{s.repo_origin}</div>}

        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          <Stat label="size" value={`${s.size_bytes} B`} />
          <Stat label="lines" value={String(s.line_count)} />
          <Stat label="sections" value={String(s.section_count)} />
          <Stat label="source" value={s.source} />
          <Stat label="hash" value={s.content_hash.slice(0, 12)} />
        </div>

        <section className="mt-4">
          <h3 className="font-semibold text-sm mb-1">
            <span className="text-warn">poison</span> {Math.round(s.poison_score * 100)}%
          </h3>
          {s.poison_reasons.length === 0 ? (
            <p className="text-subtle text-xs">問題なし.</p>
          ) : (
            <ul className="text-sm space-y-1 list-disc list-inside text-warn">
              {s.poison_reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
        </section>

        <section className="mt-4">
          <h3 className="font-semibold text-sm mb-1">
            <span className="text-accent">growth</span> {Math.round(s.growth_score * 100)}%
          </h3>
          {s.growth_notes.length === 0 ? (
            <p className="text-subtle text-xs">変化なし.</p>
          ) : (
            <ul className="text-sm space-y-1 list-disc list-inside text-accent">
              {s.growth_notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </section>

        <section className="mt-4">
          <h3 className="font-semibold text-sm mb-1">history</h3>
          <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
            {(hist?.history ?? []).map((h) => (
              <li key={h.id} className="flex items-center gap-2 bg-muted px-2 py-1 rounded">
                <span className="text-subtle font-mono">{h.content_hash.slice(0, 8)}</span>
                <span className="text-subtle">{fmtTs(h.ts)}</span>
                <span className="ml-auto text-warn">poison {Math.round(h.poison_score * 100)}%</span>
                <span className="text-accent">growth {Math.round(h.growth_score * 100)}%</span>
                <span className="text-subtle">{h.size_bytes}B</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-4">
          <h3 className="font-semibold text-sm mb-1">content preview</h3>
          <pre className="bg-muted p-2 rounded text-[11px] max-h-60 overflow-auto whitespace-pre-wrap">
            {s.content_preview}
          </pre>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted px-2 py-1 rounded">
      <div className="text-subtle text-[10px] uppercase">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
