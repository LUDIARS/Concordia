/**
 * 案内 (クラシファイアと起動案内) に載せる開催中のバウンティ企画の形 (spec/feature/bug-bounty.md §8.1 §18.5)。
 * harness / control は bug-bounty の内部を知らずにこの形だけを受け取る。
 *
 * @implements SPEC-BOUNTY-GUIDANCE
 */

export interface OpenBountyEventNotice {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  projects: readonly string[];
  guidance: string;
}

const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 期間を JST で 1 行に。 */
export function formatBountyEventPeriod(event: Pick<OpenBountyEventNotice, "startsAt" | "endsAt">): string {
  return `${JST.format(new Date(event.startsAt))}〜${JST.format(new Date(event.endsAt))} JST`;
}

/** 企画の 1 行の説明 (題名・期間・対象・案内文)。 改行は畳む。 */
export function describeBountyEvent(event: OpenBountyEventNotice): string {
  const guidance = event.guidance.replace(/\s+/g, " ").trim();
  return `「${event.title.replace(/\s+/g, " ").trim()}」(${formatBountyEventPeriod(event)}、対象: ${event.projects.join(", ")})`
    + (guidance ? ` ${guidance}` : "");
}
