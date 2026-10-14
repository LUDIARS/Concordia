/**
 * 開催中の企画を案内 (クラシファイアと起動案内) へ渡す形にする adapter (spec/feature/bug-bounty.md §18.5)。
 * 企画を読めなければ「企画は無い」として扱い、案内そのものは止めない。
 *
 * @implements SPEC-BOUNTY-GUIDANCE
 */

import type { OpenBountyEventNotice } from "../shared/bounty-event-notice.js";
import type { BountyEvent } from "./event-policy.js";

export function openBountyEventNotices(
  source: { openAt(now?: number): readonly BountyEvent[] },
  now?: number,
): OpenBountyEventNotice[] {
  try {
    return source.openAt(now).map((event) => ({
      id: event.id,
      title: event.title,
      // 早期終了した企画は openAt に出ないので、終了は予定の時刻のまま。
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      projects: [...event.projects],
      guidance: event.guidance,
    }));
  } catch {
    return [];
  }
}
