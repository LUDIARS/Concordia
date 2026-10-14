// @implements SPEC-BOUNTY-EVENT
// @implements SPEC-BOUNTY-WEBUI
import { useState } from "react";

import { api, type BountyEvent, type BountyEventInput } from "../api.js";

// バウンティ企画 (spec/feature/bug-bounty.md §0 §8.2 §18)。 企画は報告の受付条件ではなく催し: 期間中に対象プロジェクトへ
// 対象の受付口から来た報告が企画に紐付き、報奨の上書きが効く。 企画外の報告もいつもどおり受け付ける。
// 作成・編集・早期終了は admin の配下の API を呼ぶ (検証は Cc の use case が行う)。

export const BOUNTY_EVENT_PHASE_LABEL: Record<BountyEvent["phase"], string> = {
  scheduled: "予定",
  open: "開催中",
  ended: "終了",
};

const CHANNELS: Array<{ value: BountyEvent["channels"][number]; label: string }> = [
  { value: "discord", label: "Discord (/bug)" },
  { value: "session", label: "セッション" },
  { value: "cocoiru", label: "Cocoiru" },
];
const SEVERITIES = ["s1", "s2", "s3", "s4"] as const;

const ERROR_LABEL: Record<string, string> = {
  title_invalid: "題名は 1〜100 文字で、改行とバッククォートを含められません。",
  guidance_invalid: "案内文は 1000 文字までで、改行とバッククォートを含められません。",
  period_invalid: "終了は開始より後にしてください。",
  projects_invalid: "対象プロジェクトを 1〜50 件指定してください。",
  unknown_project: "登録されていないプロジェクトコードがあります。",
  channels_invalid: "受付口を 1 つ以上選んでください。",
  reward_override_invalid: "報奨の上書きは 0 以上の整数にしてください。",
  event_projects_reduced: "開始済みの企画の対象プロジェクトは減らせません。",
  event_started: "開始済みの企画の開始時刻は変えられません。",
  event_ended: "終了した企画は変えられません。",
  state_changed: "他の操作が先に入りました。読み込み直してください。",
};

interface Form {
  title: string;
  starts: string;
  ends: string;
  projects: string;
  channels: Array<BountyEvent["channels"][number]>;
  guidance: string;
  override: Record<(typeof SEVERITIES)[number], string>;
}

/** datetime-local の値 (端末のローカル時刻) とミリ秒の変換。 */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const emptyForm = (): Form => ({
  title: "", starts: "", ends: "", projects: "", channels: ["discord", "session"], guidance: "",
  override: { s1: "", s2: "", s3: "", s4: "" },
});

function formOf(event: BountyEvent): Form {
  return {
    title: event.title,
    starts: toLocalInput(event.starts_at),
    ends: toLocalInput(event.ends_at),
    projects: event.projects.join(", "),
    channels: [...event.channels],
    guidance: event.guidance,
    override: {
      s1: String(event.reward_override?.s1 ?? ""), s2: String(event.reward_override?.s2 ?? ""),
      s3: String(event.reward_override?.s3 ?? ""), s4: String(event.reward_override?.s4 ?? ""),
    },
  };
}

/** 画面の入力を API の形へ。 数値にならない上書きは送らず、上書きが 1 つも無ければ null。 */
export function toEventInput(form: Form): BountyEventInput {
  const override: Partial<Record<(typeof SEVERITIES)[number], number>> = {};
  for (const severity of SEVERITIES) {
    const raw = form.override[severity].trim();
    if (raw !== "") override[severity] = Number(raw);
  }
  return {
    title: form.title.trim(),
    starts_at: new Date(form.starts).getTime(),
    ends_at: new Date(form.ends).getTime(),
    projects: form.projects.split(/[\s,、]+/).map((code) => code.trim()).filter(Boolean),
    channels: form.channels,
    guidance: form.guidance.trim(),
    reward_override: Object.keys(override).length > 0 ? override : null,
  };
}

const formatTime = (ms: number | null): string => (ms ? new Date(ms).toLocaleString("ja-JP") : "—");

export function BountyEvents({ events, onChanged }: { events: BountyEvent[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [message, setMessage] = useState<string | null>(null);

  const start = (event: BountyEvent | null) => {
    setEditing(event ? event.id : "new");
    setForm(event ? formOf(event) : emptyForm());
    setMessage(null);
  };

  const failed = (e: unknown) => {
    const code = (e as Error).message;
    setMessage(Object.entries(ERROR_LABEL).find(([key]) => code.includes(key))?.[1] ?? `保存できませんでした: ${code}`);
  };

  const save = async () => {
    try {
      const body = toEventInput(form);
      if (editing === "new") await api.bountyCreateEvent(body);
      else if (editing) await api.bountyUpdateEvent(editing, body);
      setEditing(null);
      setMessage("企画を保存しました。");
      onChanged();
    } catch (e) {
      failed(e);
    }
  };

  const end = async (event: BountyEvent) => {
    try {
      await api.bountyEndEvent(event.id);
      setMessage(`企画「${event.title}」を終了しました。`);
      onChanged();
    } catch (e) {
      failed(e);
    }
  };

  const toggleChannel = (value: BountyEvent["channels"][number]) => setForm((current) => ({
    ...current,
    channels: current.channels.includes(value) ? current.channels.filter((item) => item !== value) : [...current.channels, value],
  }));

  return (
    <section className="border border-border rounded p-3 space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">バウンティ企画</h2>
        <button type="button" className="ml-auto px-2 py-1 rounded border border-border text-xs" onClick={() => start(null)}>
          企画を作る
        </button>
      </div>
      <p className="text-xs text-subtle">
        期間中に対象プロジェクトへ、選んだ受付口から来た報告が企画に紐付き、報奨の上書きが効きます。企画外の報告もいつもどおり
        受け付けます。開催中の企画は作業中のエージェントへの案内にも載ります。
      </p>

      {events.length === 0 && <div className="text-xs text-subtle">企画はまだありません。</div>}
      {events.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-subtle border-b border-border">
              <th className="py-1 pr-2">企画</th>
              <th className="py-1 pr-2">状態</th>
              <th className="py-1 pr-2">期間</th>
              <th className="py-1 pr-2">対象</th>
              <th className="py-1 pr-2">受付口</th>
              <th className="py-1 pr-2">報奨の上書き</th>
              <th className="py-1 pr-2" />
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} className="border-b border-border">
                <td className="py-1.5 pr-2">
                  <div>{event.title}</div>
                  <div className="text-subtle font-mono">{event.id}</div>
                </td>
                <td className="py-1.5 pr-2">{BOUNTY_EVENT_PHASE_LABEL[event.phase]}</td>
                <td className="py-1.5 pr-2">
                  {formatTime(event.starts_at)} 〜 {formatTime(event.ended_early_at ?? event.ends_at)}
                  {event.ended_early_at ? " (早期終了)" : ""}
                </td>
                <td className="py-1.5 pr-2">{event.projects.join(", ")}</td>
                <td className="py-1.5 pr-2">{event.channels.join(", ")}</td>
                <td className="py-1.5 pr-2">
                  {event.reward_override
                    ? SEVERITIES.filter((s) => event.reward_override?.[s] !== undefined).map((s) => `${s}: ${event.reward_override?.[s]}`).join(" / ")
                    : "既定値"}
                </td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  {event.phase !== "ended" && (
                    <>
                      <button type="button" className="px-2 py-0.5 rounded border border-border mr-1" onClick={() => start(event)}>編集</button>
                      <button type="button" className="px-2 py-0.5 rounded border border-border" onClick={() => void end(event)}>早期終了</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="border border-border rounded p-2 space-y-2 text-xs" aria-label="企画の編集">
          <label className="block space-y-1">
            <span className="text-subtle block">題名</span>
            <input className="foundation-form text-xs w-full" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="space-y-1">
              <span className="text-subtle block">開始</span>
              <input type="datetime-local" className="foundation-form text-xs" value={form.starts}
                onChange={(e) => setForm({ ...form, starts: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-subtle block">終了</span>
              <input type="datetime-local" className="foundation-form text-xs" value={form.ends}
                onChange={(e) => setForm({ ...form, ends: e.target.value })} />
            </label>
            <label className="space-y-1 flex-1 min-w-48">
              <span className="text-subtle block">対象プロジェクト (コード、カンマ区切り)</span>
              <input className="foundation-form text-xs w-full" value={form.projects} placeholder="例: Cc, Ar"
                onChange={(e) => setForm({ ...form, projects: e.target.value })} />
            </label>
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="text-subtle">受付口</legend>
            {CHANNELS.map((channel) => (
              <label key={channel.value} className="flex items-center gap-1">
                <input type="checkbox" checked={form.channels.includes(channel.value)} onChange={() => toggleChannel(channel.value)} />
                {channel.label}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1">
            <span className="text-subtle block">案内文 (1 行、作業中のエージェントへの案内にも載ります)</span>
            <input className="foundation-form text-xs w-full" value={form.guidance} onChange={(e) => setForm({ ...form, guidance: e.target.value })} />
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="text-subtle">報奨の上書き (トークン数、空欄は個人の AI 予算の既定値)</legend>
            {SEVERITIES.map((severity) => (
              <label key={severity} className="flex items-center gap-1">
                {severity}
                <input inputMode="numeric" className="foundation-form text-xs w-28" value={form.override[severity]}
                  onChange={(e) => setForm({ ...form, override: { ...form.override, [severity]: e.target.value } })} />
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => void save()}>保存</button>
            <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => setEditing(null)}>やめる</button>
          </div>
        </div>
      )}
      {message && <div className="text-xs">{message}</div>}
    </section>
  );
}
