/**
 * 届いたプラン更新 (デスクトップの Claude アプリの hook・agy の CLI) を、 セッションへ反映する
 * (spec/feature/session-plan-discord.md)。
 *
 * - プラン全体を組み立て直して metadata に保存する (状態の 1 行 `status` も一緒に持つ)。
 * - ステップを session_task_records へ写す (Discord の状態カードと残作業の判定が読む)。
 * - 状態が変わったとき・サマリが出たときに、 セッションの Discord スレッドへ投稿する。
 *
 * @implements SPEC-SESSION-PLAN-DISCORD
 */

import type { ChatRepo } from "../../db/chat-repo.js";
import type { SessionTaskRecordsRepo } from "../../db/session-task-records-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { SessionRow } from "../../shared/types.js";
import {
  applySessionPlanCall,
  SESSION_PLAN_METADATA_KEY,
  parseSessionPlanCall,
  readSessionPlan,
} from "../../session-plan/plan-state.js";
import { sessionPlanAuthorLabel, sessionPlanPost, sessionPlanStatus } from "../../session-plan/plan-posts.js";

export interface SessionPlanEventDeps {
  repo: Pick<SessionsRepo, "mergeMetadata">;
  sessionTaskRecords: Pick<SessionTaskRecordsRepo, "applyTaskUpdate">;
  chat: Pick<ChatRepo, "insert">;
  /** 保存した system 投稿を配る (session_id 付きの system 投稿は egress がセッションのスレッドへ送る)。 */
  announce(message: ReturnType<ChatRepo["insert"]>): void;
}

export interface SessionPlanEventResult {
  status: string | null;
  posted: boolean;
}

/** プラン更新 1 件を反映する。 payload の形が違えば何もせず null。 */
export function applySessionPlanEvent(
  deps: SessionPlanEventDeps,
  session: Pick<SessionRow, "id" | "metadata" | "provider">,
  payload: unknown,
  nowSec: number,
): SessionPlanEventResult | null {
  const call = parseSessionPlanCall(payload);
  if (!call) return null;
  const previous = readSessionPlan(session.metadata);
  const next = applySessionPlanCall(previous, call, nowSec);
  const status = sessionPlanStatus(next);
  deps.repo.mergeMetadata(session.id, { [SESSION_PLAN_METADATA_KEY]: { ...next, status } });
  if (next.steps.length > 0) {
    deps.sessionTaskRecords.applyTaskUpdate({
      session_id: session.id,
      todos: next.steps.map((step) => ({ content: step.content, activeForm: step.content, status: step.status })),
      nowSec,
    });
  }
  const text = sessionPlanPost(previous, next);
  if (text === null) return { status, posted: false };
  deps.announce(deps.chat.insert({
    channel: "system",
    session_id: session.id,
    author_label: sessionPlanAuthorLabel(session.provider),
    text,
    in_reply_to: null,
    is_actionable: false,
  }));
  return { status, posted: true };
}
