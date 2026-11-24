/**
 * 催促の use case。予定時刻を過ぎた開いているカードに Cc が知らせを出し、送信記録を残す (CC-V5-INV-05)。
 * 判定は reminder-policy.ts、届け先は port (依頼窓口のスレッド → 無ければ管制チャンネル)。
 *
 * @implements spec/feature/control-cards.md — 催促 (CC-V5-INV-05)
 */
import type { ControlCard } from "./card-domain.js";
import { decideReminder, nextRemindAt, reminderMention, renderReminder } from "./reminder-policy.js";
import type { ControlCardsRepository } from "./repository.js";

export interface ReminderDelivery {
  /** 送れた届け先の名前 (記録用)。送れなければ null。mentionUserId は担当者 1 人だけ。 */
  deliver(input: { card: ControlCard; text: string; mentionUserId: string | null }): Promise<string | null>;
}

export interface ReminderRunnerPorts {
  repo: ControlCardsRepository;
  delivery: ReminderDelivery;
  now: () => number;
  isQuietHours: (nowMs: number) => boolean;
  log: { warn(message: string): void };
}

export async function runReminders(ports: ReminderRunnerPorts): Promise<string[]> {
  const sent: string[] = [];
  for (const card of ports.repo.listOpen()) {
    const nowMs = ports.now();
    const decision = decideReminder({ card, lastSentAt: ports.repo.lastReminderAt(card.id), nowMs, quiet: ports.isQuietHours(nowMs) });
    if (decision.kind !== "send") continue;
    const text = renderReminder(card, nowMs, card.raised_at);
    let channel: string | null = null;
    try {
      channel = await ports.delivery.deliver({ card, text, mentionUserId: reminderMention(card.assignee) });
    } catch (error) {
      ports.log.warn(`control card reminder failed card=${card.id}: ${String(error)}`);
    }
    if (!channel) continue;
    ports.repo.recordReminder(card.id, nowMs, channel, text);
    ports.repo.reschedule(card.id, nextRemindAt(nowMs), nowMs);
    sent.push(card.id);
  }
  return sent;
}
