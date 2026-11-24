/**
 * 依頼の詳細 (Cc v5)。状態・起動したセッションへのリンク (Discord / Web チャット)・カード・セッションのプランと進捗。
 * セッション本体の会話は Discord のセッション用チャンネルか Web チャットで読む (実装メモ 2)。
 */
import { controlApi } from "../control/controlApi.js";
import { SessionProgress } from "../control/SessionProgress.js";
import { usePolling } from "../control/usePolling.js";
import { DESK_STATE_LABEL } from "./deskLabels.js";

export function DeskDetail({ id }: { id: string }) {
  const detail = usePolling((signal) => controlApi.deskRequest(id, signal), 10_000);
  const sessions = usePolling((signal) => controlApi.sessions(signal), 15_000);
  if (detail.error && !detail.data) return <p role="alert" className="text-amber-400">依頼を取得できません: {detail.error}</p>;
  if (!detail.data) return <p className="text-subtle">読み込み中…</p>;
  const { request, cards } = detail.data;
  const progress = request.session_id ? sessions.data?.items.find((row) => row.session_id === request.session_id) ?? null : null;
  return <section className="border border-border rounded p-4 space-y-3" aria-label="依頼の詳細">
    <div className="flex flex-wrap gap-2"><strong>{DESK_STATE_LABEL[request.state]}</strong>
      <span className="text-subtle text-sm">{request.origin} · {request.provider} · {request.id.slice(0, 8)}</span></div>
    <p className="whitespace-pre-wrap break-words">{request.body}</p>
    {request.error && <p className="text-red-400 whitespace-pre-wrap">{request.error}</p>}
    {request.links && <div className="flex gap-3 text-sm">
      <a href={request.links.web} className="text-accent underline">Web チャット</a>
      {request.links.discord ? <a href={request.links.discord} className="text-accent underline">Discord のセッションチャンネル</a> : <span className="text-subtle">Discord のチャンネルは未作成</span>}
    </div>}
    <div>
      <h3 className="font-semibold">カード ({cards.filter((card) => card.state === "open").length} 件が開いています)</h3>
      {cards.length === 0 ? <p className="text-subtle text-sm">カードはありません。</p>
        : <ul className="text-sm">{cards.map((card) => <li key={card.id}>{card.state === "open" ? "🃏" : "✅"} {card.summary}</li>)}</ul>}
    </div>
    {request.session_id && (progress ? <SessionProgress row={progress} />
      : <p className="text-subtle text-sm">{sessions.error ? `プランと進捗を取得できません: ${sessions.error}` : "プランと進捗はまだありません。"}</p>)}
  </section>;
}
