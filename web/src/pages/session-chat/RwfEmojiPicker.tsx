import { useEffect, useMemo, useState } from "react";

interface EmojiChoice { emoji: string; label: string; group: string; skill?: string }

/** @implements spec/feature/session-message-webui-chat.md — RWF絵文字入力 */
export function RwfEmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<EmojiChoice[]>([]);
  const groups = useMemo(() => {
    const result = new Map<string, EmojiChoice[]>();
    for (const choice of choices) {
      const group = result.get(choice.group) ?? [];
      group.push(choice);
      result.set(choice.group, group);
    }
    return [...result.entries()];
  }, [choices]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(null);
    const read = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`RWFの登録一覧を取得できません (${response.status})`);
      return response.json();
    };
    void Promise.all([read("/v1/admin/reaction-mappings"), read("/v1/admin/reaction-skill-workflows")]).then(([mappings, skills]) => {
      if (controller.signal.aborted) return;
      const result = new Map<string, EmojiChoice>();
      const key = (emoji: string) => emoji.replace(/[\uFE0E\uFE0F]/g, "");
      const pairs = (value: unknown) => (value && typeof value === "object" ? Object.entries(value as Record<string, unknown>) : []);
      for (const [emoji, action] of [...pairs(mappings.defaults), ...pairs(mappings.overrides)]) {
        if (typeof action === "string") result.set(key(emoji), { emoji, group: `action:${action}`,
          label: typeof mappings.action_help?.[action] === "string" ? mappings.action_help[action] : action });
        else if (action === null) result.delete(key(emoji));
      }
      for (const entry of skills.entries ?? []) {
        if (typeof entry.emoji === "string" && typeof entry.skill === "string" && entry.skill.trim()) {
          const skill = entry.skill.trim();
          result.set(key(entry.emoji), { emoji: entry.emoji, label: entry.label || skill,
            skill, group: `skill:${skill}` });
        }
      }
      setChoices([...result.values()]);
    }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);
  return <div className="relative">
    <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="rounded border border-border px-3 py-1 text-sm">RWF絵文字</button>
    {open && <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-[min(24rem,50dvh)] overflow-y-auto overscroll-contain rounded border border-border bg-surface p-2 shadow-lg" aria-label="RWF登録済み絵文字">
      {loading && <span role="status">読み込み中…</span>}
      {error && <span role="alert">{error}</span>}
      {!loading && !error && choices.length === 0 && <span>登録済みの絵文字はありません</span>}
      {!loading && !error && <ul className="space-y-2">{groups.map(([key, group]) => <li key={key} className="rounded bg-muted p-2">
        <div className="break-all text-sm font-semibold">{group[0].skill ? `/${group[0].skill}` : group[0].label}</div>
        <div className="flex flex-wrap gap-2">{group.map(({ emoji, label, skill }) => <button key={emoji} type="button" disabled={disabled}
          title={skill ? `/${skill} — ${label}` : label} aria-label={`${emoji} ${label}`}
          className="min-h-11 min-w-11 rounded border border-border px-2 py-1 text-left" onClick={() => { onPick(emoji); setOpen(false); }}>
          <span className="text-xl">{emoji}</span>{skill && label !== skill && <span className="ml-2 text-xs">{label}</span>}
        </button>)}</div>
      </li>)}</ul>}
    </div>}
  </div>;
}
