/**
 * セッションの直近の人間の指示 (Discord / Slack から届いた inject の本文) を取り出す。
 * ゴールを止める質問かを判定する材料 (spec/feature/goal-stop-question-guard.md)。
 *
 * @implements SPEC-GOAL-STOP-Q-03
 */

import type { SessionEventRow } from "../../shared/types.js";
import { parseRequesterSource } from "../requester.js";

/** 1 件あたりの長さの上限 (LLM に渡す量を抑える)。 */
const MAX_TEXT = 600;

/**
 * 新しい順の events から、人間の inject の本文を古い順に最大 `limit` 件返す。
 * 自動 inject (auto:* / delegation:* など) は人間の指示ではないので含めない。
 */
export function recentHumanInstructions(eventsNewestFirst: SessionEventRow[], limit = 3): string[] {
  const texts: string[] = [];
  for (const ev of eventsNewestFirst) {
    if (texts.length >= limit) break;
    if (ev.kind !== "inject") continue;
    let payload: { source?: unknown; text?: unknown };
    try {
      payload = JSON.parse(ev.payload) as { source?: unknown; text?: unknown };
    } catch {
      continue;
    }
    if (!parseRequesterSource(payload.source)) continue;
    if (typeof payload.text !== "string" || !payload.text.trim()) continue;
    texts.push(payload.text.trim().slice(0, MAX_TEXT));
  }
  return texts.reverse();
}
