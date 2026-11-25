import type { ControlCardView } from "./controlApi.js";

export function CardDescription({ card }: { card: ControlCardView }) {
  const fallback = card.card_kind === "human_judgment" ? "必要な判断を確認する" : "必要な操作を確認する";
  return <>
    <h3 className="break-words text-lg font-semibold">{card.human_action || fallback}</h3>
    {card.summary && <details className="text-sm">
      <summary className="cursor-pointer text-subtle">詳細</summary>
      <p className="break-words">{card.summary}</p>
    </details>}
  </>;
}
