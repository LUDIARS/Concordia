import { useState } from "react";
import type { ControlCardView, SessionProgressRow } from "./controlApi.js";
import { SessionProgress } from "./SessionProgress.js";
import { SessionChat } from "../session-chat/SessionChat.js";
import { DeskDetail } from "../desk/DeskDetail.js";
import { projectCards, sessionStatus } from "./projectGraph.js";
import { GEN5_STAGES } from "../../../../src/desk/gen5-stage.js";
import { CardDescription } from "./CardDescription.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";

export function ProjectMicro({ project, sessions, cards, cardError, cardsReconnecting }: {
  project: string; sessions: SessionProgressRow[]; cards: ControlCardView[]; cardError: string | null; cardsReconnecting: boolean;
}) {
  const [chat, setChat] = useState<string | null>(null);
  const related = projectCards(cards, project, sessions);
  return <div className="space-y-3">
    {(related.length > 0 || cardError || cardsReconnecting) && <section aria-label="関連する管制カード" className="space-y-2">
      <h3 className="font-semibold">関連するカード</h3>
      {cardsReconnecting ? <ReconnectingStatus /> : cardError && <p role="alert" className="text-amber-400">カードを取得できません: {cardError}</p>}
      <ul className="space-y-2">{related.map(card => <li key={card.id} className="space-y-1 rounded border border-border p-3">
        <CardDescription card={card} />
        {card.link && <a href={card.link} className="text-sm text-accent underline">回答する</a>}
      </li>)}</ul>
    </section>}
    {sessions.map(row => <article key={row.session_id} className="rounded border border-border bg-surface p-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <strong>{row.current_task || "作業内容未報告"}</strong>
      <button className="text-xs text-accent underline" aria-expanded={chat === row.session_id}
        onClick={() => setChat(chat === row.session_id ? null : row.session_id)}>{chat === row.session_id ? "チャットを閉じる" : "チャットを開く"}</button>
    </header>
    <p className="my-2 text-xs">{sessionStatus[row.status ?? ""] ?? row.status ?? "未分類"} · Gen5　{row.gen5_stage ?? "工程未報告"}</p>
    {row.desk_task_reference && row.desk_request_id && <a className="text-xs text-accent underline"
      href={`/desk?request=${encodeURIComponent(row.desk_request_id)}`}>{row.desk_task_reference}</a>}
    {row.gen5_stage && <ol aria-label="Gen5 ワークフロー" className="flex flex-wrap items-center gap-y-1 py-2 text-xs">
      {GEN5_STAGES.map((stage, index) => <li key={stage} className="flex items-center">
        {index > 0 && <span aria-hidden="true" className="w-3 border-t border-border" />}
        <span aria-current={stage === row.gen5_stage ? "step" : undefined} className={stage === row.gen5_stage ? "rounded bg-accent px-2 py-1 text-white" : "rounded border border-border px-2 py-1 text-subtle"}>{stage}</span>
      </li>)}
    </ol>}
    <ol aria-label="工程チャート" className="flex overflow-x-auto py-2 text-xs">
      {row.plan.steps.map((step, i) => <li key={i} className="flex shrink-0 items-center">
        {i > 0 && <span aria-hidden="true" className="w-4 border-t border-border" />}
        <span aria-current={step.status === "in_progress" ? "step" : undefined} className={`rounded border px-2 py-1 ${step.status === "in_progress" ? "border-accent text-accent" : "border-border"}`}>
          {step.status === "completed" ? "完了" : step.status === "in_progress" ? "進行中" : "予定"} · {step.text}
        </span></li>)}
    </ol>
    <details><summary className="cursor-pointer text-xs text-subtle">プランと進捗</summary><SessionProgress row={row} /></details>
    {chat === row.session_id && (row.desk_request_id ? <DeskDetail key={row.desk_request_id} id={row.desk_request_id} />
      : <div className="flex h-[65dvh] min-h-80"><SessionChat key={row.session_id} deskSessionId={row.session_id} /></div>)}
  </article>)}</div>;
}
