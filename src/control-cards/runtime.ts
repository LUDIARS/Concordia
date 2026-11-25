/**
 * 管制カードの組み立て (composition)。1 分周期で 同期 → dots への捌きの指令 → 催促 を回し、
 * AI の発言 (人間依頼) と指令ブリッジの出来事 (dots の回答) を購読する。
 * 届け先 (依頼窓口のスレッド・管制チャンネル) は後から差し込む。
 *
 * @implements spec/feature/control-cards.md — 結線
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { InstructionEvent, InstructionEventListener } from "../agent-instructions/instruction-events.js";
import type { RegisterInput } from "../agent-instructions/instruction-service.js";
import { eventBus } from "../events.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { isQuietHours } from "../shared/quiet-hours.js";
import { syncControlCards, type CardChange } from "./card-sync.js";
import { createTriageDispatch } from "./card-triage-dispatch.js";
import { readCardOwnership } from "./card-owner-sessions.js";
import { createHumanCommandCards, type HumanCommandParser } from "./human-command-cards.js";
import { runReminders, type ReminderDelivery } from "./reminder-runner.js";
import { ControlCardsRepository } from "./repository.js";
import { ControlCardsService } from "./service.js";
import { createCardSources } from "./sources.js";
import type { DeskRequest } from "../desk/desk-request-policy.js";

export const CONTROL_CARDS_TICK_MS = 60 * 1000;
const ENDED_STATUSES = new Set(["ended", "lost"]);

export interface ControlCardsRuntimeDeps {
  db: Database.Database;
  /** 巡回を回すか (session.control_session_enabled、v5 では「巡回とボード・カード」)。 */
  isEnabled: () => boolean;
  isDotsTriageEnabled: () => boolean;
  settings: { get(key: string): string | null; set(key: string, value: string): void };
  projectOf: (sessionId: string) => string | null;
  webUrl: (path: string) => string;
  instructions: {
    register: (input: RegisterInput) => { id: string };
    status: (id: string) => string | null;
    subscribe: (listener: InstructionEventListener) => () => void;
  };
  /** 依頼窓口のスレッドが無いときの催促の届け先 (管制チャンネル)。送れたら true。 */
  postToControlChannel: (text: string) => Promise<boolean>;
  parseHumanCommands: HumanCommandParser;
  deskIssues?: () => DeskRequest[];
  log: { info(message: string): void; warn(message: string): void };
}

export function createControlCardsRuntime(deps: ControlCardsRuntimeDeps) {
  const repo = new ControlCardsRepository(deps.db);
  const sessionStatus = deps.db.prepare("SELECT status FROM sessions WHERE id = ?");
  let listener: ((change: CardChange) => void) | null = null;
  let deskReminder: ReminderDelivery["deliver"] | null = null;
  let loop: SupervisedIntervalHandle | null = null;
  const onChange = (change: CardChange) => listener?.(change);

  const humanCommands = createHumanCommandCards({
    repo, parse: deps.parseHumanCommands, now: Date.now, id: randomUUID, projectOf: deps.projectOf, webUrl: deps.webUrl, onChange, log: deps.log,
  });
  const service = new ControlCardsService(repo, humanCommands, Date.now);
  const sources = createCardSources(deps.db, { projectOf: deps.projectOf, webUrl: deps.webUrl,
    ...(deps.deskIssues ? { deskIssues: deps.deskIssues } : {}) });
  const triage = createTriageDispatch({
    repo, isEnabled: deps.isDotsTriageEnabled, state: deps.settings,
    register: deps.instructions.register, instructionStatus: deps.instructions.status, now: Date.now, log: deps.log,
  });
  const delivery: ReminderDelivery = {
    async deliver(input) {
      const viaDesk = deskReminder ? await deskReminder(input) : null;
      if (viaDesk) return viaDesk;
      // 管制チャンネルへはメンションしない (担当者の指定は本文に名前で出る)。
      return (await deps.postToControlChannel(input.text)) ? "control-channel" : null;
    },
  };

  const sessionEnded = (sessionId: string): boolean | null => {
    const row = sessionStatus.get(sessionId) as { status: string } | undefined;
    return row ? ENDED_STATUSES.has(row.status) : null;
  };

  async function tick(): Promise<void> {
    if (!deps.isEnabled()) return;
    syncControlCards({ repo, sources, sessionEnded, ownership: () => readCardOwnership(deps.db), now: Date.now, id: randomUUID, onChange, log: deps.log });
    try { triage.tick(); } catch (error) { deps.log.warn(`card_triage dispatch failed: ${String(error)}`); }
    await runReminders({ repo, delivery, now: Date.now, isQuietHours: (ms) => isQuietHours(new Date(ms)), log: deps.log });
  }

  const unsubscribeMessages = eventBus.subscribe((event) => {
    // 本文は更新で後から届くことがあるので create / update の両方を見る (出所キーで 1 件にまとまる)。
    if (event.type !== "session.message") return;
    try {
      humanCommands.onSessionMessage({
        sessionId: event.target_session_id, messageId: event.message.id,
        authorType: event.message.author_type, content: event.message.content,
      });
    } catch (error) { deps.log.warn(`human-command card failed: ${String(error)}`); }
  });
  const unsubscribeInstructions = deps.instructions.subscribe((event: InstructionEvent) => {
    triage.onInstructionEvent(event);
  });

  return {
    service,
    tick,
    start(intervalMs = CONTROL_CARDS_TICK_MS): void {
      loop?.stop();
      loop = startSupervisedInterval("control-cards", tick, { intervalMs, log: { warn: (message) => deps.log.warn(message) } });
    },
    /** カードの開閉の受け手 (依頼窓口のスレッド)。 */
    attachListener(next: ((change: CardChange) => void) | null): void { listener = next; },
    /** 依頼窓口のスレッドへの催促。送れなければ null を返す。 */
    attachDeskReminder(next: ReminderDelivery["deliver"] | null): void { deskReminder = next; },
    stop(): void {
      loop?.stop();
      loop = null;
      unsubscribeMessages();
      unsubscribeInstructions();
    },
  };
}

export type ControlCardsRuntime = ReturnType<typeof createControlCardsRuntime>;
