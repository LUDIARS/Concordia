/**
 * 管制カード欄 (Cc v5)。種別・要旨・出所・経過時間・優先度・担当者・次の催促を出し、捌きを編集する。
 * 回答は各カードの回答先 (既存の画面) で行う。「済み」にできるのは人間依頼のカードだけ (CC-V5-INV-02)。
 * 破棄したカード (持ち主のセッションが active でない判断、実装メモ 14) は既定で出さず、「破棄済み n 件」の切替でだけ見る。
 */
import { useState } from "react";
import { controlApi, type ControlCardList, type ControlCardView } from "./controlApi.js";
import { usePolling } from "./usePolling.js";
import { CardDescription } from "./CardDescription.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";

const KIND_LABEL: Record<ControlCardView["card_kind"], string> = { human_action: "アクション", human_judgment: "判断" };
const PRIORITY_LABEL: Record<ControlCardView["priority"], string> = { high: "高", normal: "中", low: "低" };
const DISCARD_LABEL: Record<NonNullable<ControlCardView["discard_reason"]>, string> = {
  session_inactive: "セッション終了", session_unresolved: "セッション不明",
};

function elapsed(ms: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  return minutes < 60 ? `${minutes} 分` : minutes < 1440 ? `${Math.floor(minutes / 60)} 時間` : `${Math.floor(minutes / 1440)} 日`;
}

function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function CardEditor({ card, onSaved }: { card: ControlCardView; onSaved: () => void }) {
  const [priority, setPriority] = useState(card.priority);
  const [assignee, setAssignee] = useState(card.assignee ?? "");
  const [remindAt, setRemindAt] = useState(toLocalInput(card.remind_at));
  const [reminderText, setReminderText] = useState(card.reminder_text ?? "");
  const [group, setGroup] = useState(card.card_group ?? "");
  const [error, setError] = useState("");
  const save = async (patch: Record<string, unknown>) => {
    setError("");
    try { await controlApi.updateCard(card.id, patch); onSaved(); } catch (e) { setError(String(e)); }
  };
  return <form className="flex flex-wrap gap-2 items-end text-sm" onSubmit={(e) => {
    e.preventDefault();
    void save({ priority, assignee, remind_at: remindAt ? new Date(remindAt).toISOString() : null, reminder_text: reminderText, group });
  }}>
    <label>優先度 <select aria-label="優先度" value={priority} onChange={(e) => setPriority(e.target.value as ControlCardView["priority"])} className="bg-surface border border-border rounded p-1">
      <option value="high">高</option><option value="normal">中</option><option value="low">低</option></select></label>
    <label>担当者 <input aria-label="担当者" value={assignee} maxLength={100} onChange={(e) => setAssignee(e.target.value)} className="bg-surface border border-border rounded p-1 w-32" /></label>
    <label>次の催促 <input aria-label="次の催促" type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} className="bg-surface border border-border rounded p-1" /></label>
    <label>催促文 <input aria-label="催促文" value={reminderText} maxLength={400} onChange={(e) => setReminderText(e.target.value)} className="bg-surface border border-border rounded p-1 w-48" /></label>
    <label>まとめ先 <input aria-label="まとめ先" value={group} maxLength={100} onChange={(e) => setGroup(e.target.value)} className="bg-surface border border-border rounded p-1 w-28" /></label>
    <button className="border border-border rounded px-3 py-1">捌きを保存</button>
    {(card.source_kind === "human-command" || card.source_kind === "kaizen-proposal") && <button type="button" onClick={() => { void save({ done: true }); }} className="bg-accent text-white rounded px-3 py-1">済み</button>}
    {error && <span role="alert" className="text-red-400">{error}</span>}
  </form>;
}

export function CardsPanel({ openCards }: { openCards: ReturnType<typeof usePolling<ControlCardList>> }) {
  const [showDiscarded, setShowDiscarded] = useState(false);
  const discarded = usePolling(signal => controlApi.cards("discarded", signal), showDiscarded ? 15_000 : null);
  const { data, error, reconnecting, reload } = showDiscarded ? discarded : openCards;
  const [editing, setEditing] = useState<string | null>(null);
  const now = Date.now();
  const discardedCount = openCards.data?.discarded_count ?? 0;
  return <section className="space-y-2" aria-label="管制カード">
    <div className="flex items-baseline gap-3">
      <h2 className="text-lg font-semibold">{showDiscarded ? "破棄済みのカード" : "カード"} {data ? `(${data.cards.length})` : ""}</h2>
      {(showDiscarded || discardedCount > 0) && <button type="button" className="text-sm underline" aria-pressed={showDiscarded}
        onClick={() => { setEditing(null); setShowDiscarded(!showDiscarded); }}>
        {showDiscarded ? "開いているカードに戻る" : `破棄済み ${discardedCount} 件`}</button>}
    </div>
    {reconnecting ? <ReconnectingStatus /> : error && <p role="alert" className="text-amber-400">カードを取得できません: {error}</p>}
    {data && data.cards.length === 0 && <p className="text-subtle">{showDiscarded ? "破棄済みのカードはありません。" : "人間のアクション・判断が要るカードはありません。"}</p>}
    {data?.cards.map((card) => <article key={card.id} className="border border-border rounded p-3 space-y-1">
      <CardDescription card={card} />
      <div className="flex flex-wrap gap-2 text-sm">
        <strong>{KIND_LABEL[card.card_kind]}</strong>
        <span>優先度 {PRIORITY_LABEL[card.priority]}</span>
        <span className="text-subtle">{card.project ?? "プロジェクト不明"} · {elapsed(card.raised_at, now)}経過</span>
        {card.assignee && <span>担当 {card.assignee}</span>}
        {card.remind_at && <span className="text-subtle">次の催促 {new Date(card.remind_at).toLocaleString()}</span>}
        {card.triaged_by && <span className="text-subtle">捌き: {card.triaged_by}</span>}
        {card.state === "discarded" && <span className="text-subtle">破棄: {card.discard_reason ? DISCARD_LABEL[card.discard_reason] : "理由不明"}</span>}
      </div>
      <div className="flex gap-3 text-sm">
        {card.link && <a href={card.link} className="text-accent underline">回答する</a>}
        {card.session_id && <a href={`/sessions/${card.session_id}`} className="text-accent underline">セッション</a>}
        {card.state === "open" && <button type="button" className="underline" onClick={() => setEditing(editing === card.id ? null : card.id)}>捌きを変える</button>}
      </div>
      {editing === card.id && <CardEditor card={card} onSaved={() => { setEditing(null); reload(); }} />}
    </article>)}
  </section>;
}
