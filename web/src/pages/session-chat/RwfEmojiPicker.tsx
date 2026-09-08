import { useEffect, useState } from "react";

/** @implements spec/feature/session-message-webui-chat.md — RWF絵文字入力 */
export function RwfEmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Array<{ emoji: string; label: string }>>([]);
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
      const result = new Map<string, { emoji: string; label: string }>();
      const key = (emoji: string) => emoji.replace(/[\uFE0E\uFE0F]/g, "");
      const put = (emoji: string, label: string) => result.set(key(emoji), { emoji, label });
      const pairs = (value: unknown) => (value && typeof value === "object" ? Object.entries(value as Record<string, unknown>) : []);
      for (const [emoji, action] of [...pairs(mappings.defaults), ...pairs(mappings.overrides)]) {
        if (typeof action === "string") put(emoji, typeof mappings.action_help?.[action] === "string" ? mappings.action_help[action] : action);
        else if (action === null) result.delete(key(emoji));
      }
      for (const entry of skills.entries ?? []) {
        if (typeof entry.emoji === "string") put(entry.emoji, entry.label || entry.skill || entry.emoji);
      }
      setChoices([...result.values()]);
    }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);
  return <div>
    <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="rounded border border-border px-3 py-1 text-sm">RWF絵文字</button>
    {open && <div className="mt-2 flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded border border-border p-2" aria-label="RWF登録済み絵文字">
      {loading && <span role="status">読み込み中…</span>}
      {error && <span role="alert">{error}</span>}
      {!loading && !error && choices.length === 0 && <span>登録済みの絵文字はありません</span>}
      {!loading && !error && choices.map(({ emoji, label }) => <button key={emoji} type="button" disabled={disabled} title={label} aria-label={`${emoji} ${label}`}
        className="min-h-11 min-w-11 rounded bg-muted p-2 text-xl" onClick={() => { onPick(emoji); setOpen(false); }}>{emoji}</button>)}
    </div>}
  </div>;
}
