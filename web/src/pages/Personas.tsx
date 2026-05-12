import { useState } from "react";
import { api, fmtTs } from "../api.js";
import type { Persona, PersonaFeedback } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Personas() {
  const { data, error } = useLiveQuery(
    () => api.personasList(),
    ["persona.assigned", "persona.released", "persona.feedback"],
  );
  const { data: activeData } = useLiveQuery(
    () => api.personasActive(),
    ["persona.assigned", "persona.released"],
  );
  const { data: feedbackData } = useLiveQuery(
    () => api.personasFeedbackRecent(60),
    ["persona.feedback"],
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (error) return <div className="text-danger">load error: {error.message}</div>;

  const personas = data?.personas ?? [];
  const active = activeData?.active ?? [];
  const recentFeedback = feedbackData?.feedback ?? [];
  const activeMap = new Map(active.map((a) => [a.persona.id, a]));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-3">
        <header>
          <h1 className="font-semibold">Personas</h1>
          <p className="text-subtle text-sm mt-1">
            Concordia 経由で起動された AI セッションに排他的に割当てられる人格 (1 active session につき 1 persona)。
            session-end 時に chat 履歴から学習して <code>learned_notes</code> に追記される。
            ユーザの skill / memory / FS は変更しません。
          </p>
        </header>
        {personas.length === 0 && (
          <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">no personas</div>
        )}
        {personas.map((p) => (
          <PersonaCard
            key={p.id}
            p={p}
            activeSession={activeMap.get(p.id)?.session_id ?? null}
            onSelect={() => setSelected(p.id)}
          />
        ))}
      </div>
      <aside className="space-y-2">
        <h2 className="font-semibold">アクティブ assignment</h2>
        <ul className="space-y-1">
          {active.length === 0 && (
            <li className="text-subtle text-xs">なし (active session 0)</li>
          )}
          {active.map((a) => (
            <li
              key={a.assignment_id}
              className="bg-surface border border-border rounded px-2 py-1 text-[11px]"
            >
              <div className="flex items-center gap-2">
                <span className="text-accent">{a.persona.name}</span>
                <span className="text-subtle font-mono ml-auto">{a.session_id.slice(0, 8)}</span>
              </div>
              <div className="text-subtle text-[10px]">since {fmtTs(a.assigned_at)}</div>
            </li>
          ))}
        </ul>

        <h2 className="font-semibold mt-4">直近 feedback ログ</h2>
        <ul className="space-y-1">
          {recentFeedback.length === 0 && (
            <li className="text-subtle text-xs">まだ何も学習してない</li>
          )}
          {recentFeedback.map((f) => (
            <FeedbackRow key={f.id} f={f} personas={personas} />
          ))}
        </ul>
      </aside>
      {selected && (
        <PersonaDetailModal id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function PersonaCard({
  p, activeSession, onSelect,
}: {
  p: Persona;
  activeSession: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="block w-full text-left bg-surface border border-border rounded p-3 hover:border-accent transition-colors"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-accent">{p.name}</span>
        {activeSession && (
          <span className="px-1.5 py-0.5 rounded bg-ok/20 text-ok text-[10px]">
            active {activeSession.slice(0, 6)}
          </span>
        )}
        {p.learned_notes.length > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-warn/20 text-warn text-[10px]">
            learned ×{p.learned_notes.length}
          </span>
        )}
        <span className="ml-auto text-subtle font-mono">{p.id}</span>
      </div>
      <div className="mt-1 text-sm text-text">{p.description}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {p.traits.map((t, i) => (
          <span key={i} className="px-1.5 py-0.5 rounded bg-muted text-subtle text-[10px]">
            {t}
          </span>
        ))}
      </div>
    </button>
  );
}

function FeedbackRow({ f, personas }: { f: PersonaFeedback; personas: Persona[] }) {
  const persona = personas.find((p) => p.id === f.persona_id);
  return (
    <li className="bg-surface border border-border rounded px-2 py-1 text-[11px]">
      <div className="flex items-center gap-1">
        <span className={kindBadge(f.kind)}>{f.kind}</span>
        <span className="text-subtle">{persona?.name ?? f.persona_id}</span>
        <span className="text-subtle ml-auto">{fmtTs(f.ts)}</span>
      </div>
      <div className="text-text mt-0.5 line-clamp-2">{f.delta}</div>
    </li>
  );
}

function kindBadge(kind: string): string {
  const base = "px-1 rounded text-[10px]";
  switch (kind) {
    case "session-end": return `${base} bg-ok/20 text-ok`;
    case "manual":      return `${base} bg-accent/20 text-accent`;
    case "chat-update": return `${base} bg-warn/20 text-warn`;
    default:            return `${base} bg-muted text-subtle`;
  }
}

function PersonaDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useLiveQuery(
    () => api.personaDetail(id),
    ["persona.assigned", "persona.released", "persona.feedback"],
    id,
  );

  return (
    <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-lg max-w-3xl w-full max-h-[85vh] overflow-y-auto p-4 space-y-3"
      >
        {error && <div className="text-danger text-sm">load error: {error.message}</div>}
        {!data && !error && <div className="text-subtle text-sm">loading…</div>}
        {data && (
          <>
            <header className="flex items-center gap-2">
              <h2 className="font-semibold text-lg text-accent">{data.persona.name}</h2>
              <span className="text-subtle font-mono text-xs">{data.persona.id}</span>
              <button onClick={onClose} className="ml-auto text-subtle hover:text-text">×</button>
            </header>
            <p className="text-sm">{data.persona.description}</p>

            <section>
              <h3 className="text-xs text-subtle uppercase mb-1">traits</h3>
              <div className="flex flex-wrap gap-1">
                {data.persona.traits.map((t, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-muted text-text text-[11px]">
                    {t}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3 className="text-xs text-subtle uppercase mb-1">speech style</h3>
              <p className="text-xs bg-muted p-2 rounded whitespace-pre-wrap">{data.persona.speech_style}</p>
            </section>

            <section>
              <h3 className="text-xs text-subtle uppercase mb-1">
                learned notes <span className="text-accent">({data.persona.learned_notes.length})</span>
              </h3>
              {data.persona.learned_notes.length === 0 ? (
                <p className="text-subtle text-xs">まだ学習されたノートなし.</p>
              ) : (
                <ul className="space-y-1">
                  {data.persona.learned_notes.map((n, i) => (
                    <li key={i} className="text-xs bg-muted px-2 py-1 rounded">
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-xs text-subtle uppercase mb-1">feedback log</h3>
              {data.feedback.length === 0 ? (
                <p className="text-subtle text-xs">未記録.</p>
              ) : (
                <ul className="space-y-1">
                  {data.feedback.map((f) => (
                    <li key={f.id} className="text-[11px] bg-muted px-2 py-1 rounded">
                      <div className="flex items-center gap-2">
                        <span className={kindBadge(f.kind)}>{f.kind}</span>
                        {f.session_id && (
                          <span className="font-mono text-subtle">{f.session_id.slice(0, 8)}</span>
                        )}
                        <span className="text-subtle ml-auto">{fmtTs(f.ts)}</span>
                      </div>
                      <div className="text-text mt-0.5">{f.delta}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-xs text-subtle uppercase mb-1">assignment 履歴</h3>
              {data.assignments.length === 0 ? (
                <p className="text-subtle text-xs">未 assign.</p>
              ) : (
                <ul className="space-y-1">
                  {data.assignments.map((a) => (
                    <li key={a.id} className="text-[11px] bg-muted px-2 py-1 rounded font-mono">
                      <span>{a.session_id.slice(0, 12)}…</span>
                      <span className="text-subtle ml-2">
                        {fmtTs(a.assigned_at)}
                        {a.released_at ? ` → ${fmtTs(a.released_at)}` : " (active)"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <details className="text-xs">
              <summary className="cursor-pointer text-subtle">skill_template (AI に注入される)</summary>
              <pre className="mt-1 bg-muted p-2 rounded whitespace-pre-wrap text-[11px]">{data.persona.skill_template}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
