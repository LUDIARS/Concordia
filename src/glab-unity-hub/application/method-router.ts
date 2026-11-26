/**
 * メソッド名 → 処理の対応表と、 1 要求の実行 (契約 v1 §2 / §4)。
 *
 * payload の検査 → 処理 → 結果/エラーへの変換をここで一様に行う。 各サービスは
 * 契約上のエラー (HubError) を投げ、 それ以外の例外は `internal` に落とす
 * (内部の文言を外へ出さない)。 上流 (Discord / Notion / Actio / Praeforma) の失敗は
 * adapter が `upstream_unavailable` にして投げる。
 *
 * @implements spec/feature/glab-unity-hub.md §3 (GUH-METHODS)
 */

import { checkPayload, HUB_METHODS, isHubMethod, type HubMethod } from "../domain/methods.js";
import { HubError, toHubError } from "../domain/protocol.js";
import type { BreviariumPort, NotionBoardPort } from "./ports.js";
import type { HubDiscordService } from "./discord-service.js";
import type { HubSprintService } from "./sprint-service.js";
import type { HubCalliopeService } from "./calliope-service.js";
import type { HubSpecDraftService } from "./spec-draft-service.js";
import type { HubMelpomeneService } from "./melpomene-service.js";
import type { MethodContext, MethodHandler, MethodHandlers } from "./method-context.js";

export interface MethodRouterDeps {
  readonly discord: HubDiscordService;
  readonly sprint: HubSprintService;
  readonly calliope: HubCalliopeService;
  readonly spec: HubSpecDraftService;
  readonly melpomene: HubMelpomeneService;
  readonly breviarium: BreviariumPort;
  readonly notion: NotionBoardPort;
  readonly guildId: string;
  readonly notionBoards: readonly { readonly id: string; readonly name: string }[];
  readonly breviariumProjects: readonly string[];
}

export function createMethodHandlers(deps: MethodRouterDeps): MethodHandlers {
  const requireBreviariumProject = (project: string | undefined): void => {
    if (project !== undefined && !deps.breviariumProjects.includes(project)) {
      throw new HubError("not_found", "project is not configured for GLab-UnityHub");
    }
  };
  const requireBoard = (boardId: string): void => {
    if (!deps.notionBoards.some((board) => board.id === boardId)) throw new HubError("not_found", "board is not in glabUnityHub.notionBoards");
  };
  return {
    "hub.whoami": async (context) => ({
      discordUserId: context.identity.token.discordUserId,
      displayName: context.identity.member.displayName,
      guildId: deps.guildId,
      tokenLabel: context.identity.token.label,
      expiresAt: context.identity.token.expiresAt,
    }),
    "hub.capabilities": async () => ({
      methods: [...HUB_METHODS],
      notionBoards: deps.notionBoards.map((board) => ({ id: board.id, name: board.name })),
      breviariumProjects: [...deps.breviariumProjects],
    }),
    "discord.channels.list": (context) => deps.discord.listChannels(context),
    "discord.messages.list": (context, payload) => deps.discord.listMessages(context, payload),
    "discord.messages.post": (context, payload) => deps.discord.post(context, payload),
    "discord.reactions.add": (context, payload) => deps.discord.react(context, payload),
    "discord.subscribe": (context, payload) => deps.discord.subscribe(context, payload),
    "discord.unsubscribe": (context, payload) => deps.discord.unsubscribe(context, payload),
    // Breviarium と同じ内容を返す (読み取り専用、 応答はそのまま)。
    "breviarium.snapshot": async (_context, payload) => {
      requireBreviariumProject(payload.project);
      return payload.project ? deps.breviarium.projectOverview(payload.project) : deps.breviarium.listProjects();
    },
    "notion.board.query": async (_context, payload) => {
      requireBoard(payload.boardId);
      return deps.notion.query(payload.boardId, payload.cursor);
    },
    "notion.board.update": async (_context, payload) => {
      requireBoard(payload.boardId);
      if (payload.title === undefined && payload.status === undefined && payload.due === undefined) {
        throw new HubError("invalid_request", "nothing to update");
      }
      return deps.notion.update(payload.boardId, payload.pageId, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.due !== undefined ? { due: payload.due } : {}),
      });
    },
    "notion.board.create": async (_context, payload) => {
      requireBoard(payload.boardId);
      return deps.notion.create(payload.boardId, { title: payload.title, ...(payload.status ? { status: payload.status } : {}) });
    },
    "melpomene.report": (context, payload) => deps.melpomene.report(context, payload),
    "sprint.current": (context, payload) => deps.sprint.current(context, payload),
    "sprint.tasks.update": (context, payload) => deps.sprint.updateTask(context, payload),
    "calliope.product": (context, payload) => deps.calliope.product(context, payload),
    "calliope.refresh": (context, payload) => deps.calliope.refresh(context, payload),
    "spec.list": (context, payload) => deps.spec.list(context, payload),
    "spec.get": (context, payload) => deps.spec.get(context, payload),
    "spec.review": (context, payload) => deps.spec.review(context, payload),
  };
}

export type DispatchOutcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: HubError };

/** 1 要求を検査して実行する。 */
export async function dispatchMethod(
  handlers: MethodHandlers,
  context: MethodContext,
  type: string,
  payload: unknown,
): Promise<DispatchOutcome> {
  if (!isHubMethod(type)) return { ok: false, error: new HubError("not_found", `unknown method: ${type}`) };
  const method: HubMethod = type;
  const check = checkPayload(method, payload);
  if (!check.ok) return { ok: false, error: new HubError("invalid_request", check.message) };
  try {
    const handler = handlers[method] as MethodHandler<HubMethod>;
    return { ok: true, payload: await handler(context, check.payload) };
  } catch (error) {
    return { ok: false, error: toHubError(error) };
  }
}
