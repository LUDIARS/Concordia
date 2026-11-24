/**
 * Discord の依頼窓口が使う Cc 内の口 (本社 Bot だけ)。Discord 面 (src/discord/desk.ts) はこの型だけに依存し、
 * 組み立て (src/bootstrap/v5-desk-cards.ts) が実体を渡す。core から Discord モジュールを import しないための置き場所。
 *
 * @implements spec/feature/request-desk.md — Discord
 */
import type { CardChange } from "../control-cards/card-sync.js";
import type { ReminderDelivery } from "../control-cards/reminder-runner.js";
import type { DeskRequest } from "./desk-request-policy.js";
import type { SubmitDeskInput, SubmitDeskOutcome } from "./service.js";

export interface DeskDiscordPort {
  submit(input: SubmitDeskInput): SubmitDeskOutcome;
  attachThread(requestId: string, threadId: string): boolean;
  get(requestId: string): DeskRequest | null;
  findBySession(sessionId: string): DeskRequest | null;
  attachRequestListener(listener: ((request: DeskRequest) => void) | null): void;
  attachCardListener(listener: ((change: CardChange) => void) | null): void;
  attachReminder(deliver: ReminderDelivery["deliver"] | null): void;
  /** セッションの Discord チャンネル URL と Web チャットの URL。 */
  sessionLinks(sessionId: string): { discord: string | null; web: string };
  webUrl(path: string): string;
}
