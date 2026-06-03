/**
 * ぼやき (独り言) channel への投稿を、投稿者セッションの persona 情報に収集する.
 *
 * session-end の learned_notes 要約 (personas/feedback.ts) とは別系統で、
 * 投稿のたびに即時で persona_feedback_log に "つぶやき履歴" を 1 件残す.
 * これにより persona ごとの素の発話が蓄積され、 後の人格学習 / UI 表示の素材になる.
 *
 * 失敗しても chat 投稿本体を阻害しない (try/catch で内部完結).
 */

import type { PersonasRepo } from "../db/personas-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("persona-boyaki");

export interface BoyakiCollectDeps {
  personas: PersonasRepo;
  chat: ChatRepo;
}

/**
 * ぼやき投稿 (chat.posted) を投稿者セッションの persona に収集する.
 * - session_id が無い (human など) / persona 未 assign の投稿は対象外.
 * - 対象 channel が "ぼやき" でない投稿は無視 (呼び出し側でも絞るが二重防御).
 */
export function collectBoyakiToPersona(
  deps: BoyakiCollectDeps,
  input: { message_id: number; session_id: string | null },
): void {
  try {
    if (!input.session_id) return;
    const assignment = deps.personas.findActiveBySession(input.session_id);
    if (!assignment) return;
    const row = deps.chat.findById(input.message_id);
    if (!row || row.channel !== "ぼやき") return;
    const delta = row.text.trim().slice(0, 120);
    if (!delta) return;
    deps.personas.appendFeedback({
      persona_id: assignment.persona_id,
      session_id: input.session_id,
      kind: "boyaki",
      delta,
      detail: { message_id: input.message_id },
    });
    log.info(
      { persona_id: assignment.persona_id, session_id: input.session_id, message_id: input.message_id },
      "boyaki collected to persona",
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, "boyaki collect failed (skipped)");
  }
}
