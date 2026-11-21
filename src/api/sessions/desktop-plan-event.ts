/**
 * hook が届けたデスクトップの Claude アプリのプラン更新を、 セッションへ反映する
 * (spec/feature/desktop-plan-discord.md)。
 *
 * - プラン全体を組み立て直して metadata に保存する (状態の 1 行 `status` も一緒に持つ)。
 * - ステップを session_task_records へ写す (Discord の状態カードと残作業の判定が読む)。
 * - 状態が変わったとき・サマリが出たときに、 セッションの Discord スレッドへ投稿する。
 *
 * @implements SPEC-DESKTOP-PLAN-DISCORD
 */

import type { ChatRepo } from "../../db/chat-repo.js";
import type { SessionTaskRecordsRepo } from "../../db/session-task-records-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { SessionRow } from "../../shared/types.js";
import {
  applyDesktopPlanCall,
  DESKTOP_PLAN_METADATA_KEY,
  parseDesktopPlanCall,
  readDesktopPlan,
} from "../../desktop-plan/plan-state.js";
import { desktopPlanPost, desktopPlanStatus } from "../../desktop-plan/plan-posts.js";

export const DESKTOP_PLAN_AUTHOR_LABEL = "Claude プラン";

export interface DesktopPlanEventDeps {
  repo: Pick<SessionsRepo, "mergeMetadata">;
  sessionTaskRecords: Pick<SessionTaskRecordsRepo, "applyTaskUpdate">;
  chat: Pick<ChatRepo, "insert">;
  /** 保存した system 投稿を配る (session_id 付きの system 投稿は egress がセッションのスレッドへ送る)。 */
  announce(message: ReturnType<ChatRepo["insert"]>): void;
}

export interface DesktopPlanEventResult {
  status: string | null;
  posted: boolean;
}

/** プラン更新 1 件を反映する。 payload の形が違えば何もせず null。 */
export function applyDesktopPlanEvent(
  deps: DesktopPlanEventDeps,
  session: Pick<SessionRow, "id" | "metadata">,
  payload: unknown,
  nowSec: number,
): DesktopPlanEventResult | null {
  const call = parseDesktopPlanCall(payload);
  if (!call) return null;
  const previous = readDesktopPlan(session.metadata);
  const next = applyDesktopPlanCall(previous, call, nowSec);
  const status = desktopPlanStatus(next);
  deps.repo.mergeMetadata(session.id, { [DESKTOP_PLAN_METADATA_KEY]: { ...next, status } });
  if (next.steps.length > 0) {
    deps.sessionTaskRecords.applyTaskUpdate({
      session_id: session.id,
      todos: next.steps.map((step) => ({ content: step.content, activeForm: step.content, status: step.status })),
      nowSec,
    });
  }
  const text = desktopPlanPost(previous, next);
  if (text === null) return { status, posted: false };
  deps.announce(deps.chat.insert({
    channel: "system",
    session_id: session.id,
    author_label: DESKTOP_PLAN_AUTHOR_LABEL,
    text,
    in_reply_to: null,
    is_actionable: false,
  }));
  return { status, posted: true };
}
