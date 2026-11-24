/**
 * Cc v5 (依頼窓口・管制カード・セッションのプランと進捗) の組み立て。core.ts から 1 回だけ呼ぶ。
 * 各 runtime を作り、API・Discord・巡回へ渡す口を返す。業務判断は各ドメインに置き、ここは結線だけ。
 *
 * @implements spec/plan/2026-11-24-control-session-to-dots.md — 結線
 */
import type Database from "better-sqlite3";
import type { DeskApiDeps } from "../api/desk.js";
import type { ControlCardsApiDeps } from "../api/control-cards.js";
import { createControlCardsRuntime, type ControlCardsRuntime } from "../control-cards/runtime.js";
import { createSessionProgressReader } from "../control-session/session-progress-reader.js";
import type { ControlBoardRowWithLink } from "../control-session/session-link.js";
import type { DeskDiscordPort } from "../desk/discord-port.js";
import type { HumanCommandParser } from "../control-cards/human-command-cards.js";
import { createDeskRuntime, type DeskRuntime } from "../desk/runtime.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";
import type { InstructionEventListener } from "../agent-instructions/instruction-events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TaskStore } from "../taskflow/store.js";
import { readLinkedTaskViews, readSessionTaskLinks } from "../work/session-task-links.js";
import type { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";
import type { SessionWithProgress } from "../control-session/session-progress-view.js";

export interface V5Deps {
  db: Database.Database;
  concordiaUrl: string;
  /** 人間が開く Web の起点 (公開ホストがあればそちら)。 */
  webBase: string;
  settings: { get(key: string): string | null; set(key: string, value: string): void };
  flags: {
    controlEnabled(): boolean;
    deskEnabled(): boolean;
    deskDepartmentId(): string | null;
    dotsTriageEnabled(): boolean;
  };
  departmentExists: (id: string) => boolean;
  isCostBlocked: () => boolean;
  workspaceRoot: () => string;
  writePrompt: (text: string) => Promise<string>;
  projectOf: (sessionId: string) => string | null;
  sessionDiscordUrl: (sessionId: string) => string | null;
  instructions: { service: InstructionService; subscribe: (listener: InstructionEventListener) => () => void };
  postToControlChannel: (text: string) => Promise<boolean>;
  /** 人間依頼マーカーの解釈 (src/discord/human-command-marker.ts、core.ts から渡す)。 */
  parseHumanCommands: HumanCommandParser;
  boardRows: () => ControlBoardRowWithLink[];
  sessions: Pick<SessionsRepo, "findSession">;
  taskStore: Pick<TaskStore, "read" | "readReference">;
  sprints: SprintDialoguesRepository;
  log: { info(message: string): void; warn(message: string): void };
}

export interface V5Runtime {
  desk: DeskRuntime;
  cards: ControlCardsRuntime;
  deskApi: DeskApiDeps;
  cardsApi: ControlCardsApiDeps;
  deskDiscord: DeskDiscordPort;
  sessionProgress: () => Promise<SessionWithProgress[]>;
  humanRequestDone: (input: { sessionMessageId: number; index: number; userId: string }) => void;
}

export function createV5Runtime(deps: V5Deps): V5Runtime {
  const webUrl = (path: string) => `${deps.webBase.replace(/\/+$/, "")}${path}`;
  const desk = createDeskRuntime({
    db: deps.db,
    concordiaUrl: deps.concordiaUrl,
    isEnabled: deps.flags.deskEnabled,
    isCostBlocked: deps.isCostBlocked,
    workspaceRoot: deps.workspaceRoot,
    departmentId: () => {
      const id = deps.flags.deskDepartmentId();
      return id && deps.departmentExists(id) ? id : null;
    },
    writePrompt: deps.writePrompt,
  });
  const cards = createControlCardsRuntime({
    db: deps.db,
    isEnabled: deps.flags.controlEnabled,
    isDotsTriageEnabled: deps.flags.dotsTriageEnabled,
    settings: deps.settings,
    projectOf: deps.projectOf,
    webUrl,
    instructions: {
      register: (input) => deps.instructions.service.register(input),
      status: (id) => deps.instructions.service.get(id)?.status ?? null,
      subscribe: deps.instructions.subscribe,
    },
    postToControlChannel: deps.postToControlChannel,
    parseHumanCommands: deps.parseHumanCommands,
    log: deps.log,
  });
  const sessionLinks = (sessionId: string) => ({ discord: deps.sessionDiscordUrl(sessionId), web: webUrl(`/sessions/${sessionId}`) });
  const cardSummaries = (sessionId: string) => cards.service.bySession(sessionId).map((card) => ({
    id: card.id, card_kind: card.card_kind, summary: card.summary, state: card.state, priority: card.priority,
    raised_at: card.raised_at, closed_at: card.closed_at,
  }));
  const progress = createSessionProgressReader({
    db: deps.db,
    boardRows: deps.boardRows,
    hasTaskLinks: (metadata) => readSessionTaskLinks(metadata).length > 0,
    readTaskLinks: async (sessionId) => {
      const result = await readLinkedTaskViews({ sessions: deps.sessions, tasks: deps.taskStore, sessionId });
      if (result.kind !== "current") return null;
      return result.links.map((link) => ({ reference: link.task_reference, status: link.status, state: link.state }));
    },
  });
  return {
    desk,
    cards,
    deskApi: { service: desk.service, cardsForSession: cardSummaries, sessionLinks },
    cardsApi: { service: cards.service, sprints: () => deps.sprints.list() },
    deskDiscord: {
      submit: (input) => desk.service.submit(input),
      attachThread: (id, threadId) => desk.service.attachThread(id, threadId),
      get: (id) => desk.service.get(id),
      findBySession: (sessionId) => desk.service.findBySession(sessionId),
      attachRequestListener: (listener) => desk.attachListener(listener),
      attachCardListener: (listener) => cards.attachListener(listener),
      attachReminder: (deliver) => cards.attachDeskReminder(deliver),
      sessionLinks,
      webUrl,
    },
    sessionProgress: async () => (await progress.read()).map(row => {
      const request = desk.service.findBySession(row.session_id);
      return { ...row, desk_request_id: request?.id ?? null,
        gen5_stage: request ? desk.service.repo.gen5Stage(row.session_id)?.label ?? null : null };
    }),
    humanRequestDone: ({ sessionMessageId, index, userId }) => {
      cards.service.markHumanCommandDone(sessionMessageId, index, `discord:${userId}`);
    },
  };
}
