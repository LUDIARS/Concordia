import type { ConcordiaEvent } from "../events.js";

export type OperationalClaimEvent = Extract<
  ConcordiaEvent,
  { type: "operational.claim.opened" | "operational.claim.released" }
>;

/** Discord / Slack 共通の claim lifecycle 投稿本文。 */
export function renderOperationalClaimMessage(event: OperationalClaimEvent): string {
  const isOpen = event.type === "operational.claim.opened";
  const lines = [
    `${isOpen ? "📣" : "✅"} [${inline(event.claim_kind)} claim] を${isOpen ? "開始" : "解放"}`,
    `対象: \`${inline(event.resource)}\``,
  ];
  if (event.branch) lines.push(`ブランチ: \`${inline(event.branch)}\``);
  if (event.note) lines.push(`内容: ${event.note}`);
  if (isOpen && event.conflict_session_ids.length > 0) {
    lines.push(`⚠️ 競合中の session: ${event.conflict_session_ids.length} 件`);
  }
  return lines.join("\n");
}

function inline(value: string): string {
  return value.replace(/[`\r\n]/g, " ").trim();
}
