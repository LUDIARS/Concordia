/**
 * セッション graceful end 時に、 wrapped AI セッションに `/session-end` の実行を
 * 促すための inject ヘルパ.
 *
 * 背景: DELETE /v1/sessions/:id (Discord `/end-session` 含む) では Concordia
 * 側で status=ended + report 生成 + ポエム投稿が走るが、 「AI 自身に
 * `/session-end` を実行させる」 ステップが無かったため、 session-logs への
 * 保存や memory 更新が行われていなかった (2026-05-27 報告).
 *
 * 修正: status 変更前に `session.inject` event を emit して Lictor の WS
 * 経由で wrapped session に slash command (Claude)、 skill invocation (Codex)、
 * または自然言語 (その他 provider) を流し込む. Lictor 側の `onInject` が provider-別 submit 戦略で
 * pty に書き出すので、 ここでは provider に応じた text を選んで emit する
 * だけでよい.
 *
 * fire-and-forget: WS が繋がっていなければ silent drop. status 変更や
 * report 生成は inject の成否に依存しない.
 */

import type { SessionRow } from "../shared/types.js";
import { eventBus } from "../events.js";

export const AUTO_SESSION_END_INJECT_SOURCE = "auto:session-end";

/**
 * provider に応じて wrapped session に流し込む文字列を選ぶ.
 * - Claude Code: `/session-end` slash command (`.claude/commands/session-end.md`)
 * - Codex: `$session-end` skill invocation (`~/.codex/skills/session-end/SKILL.md`)
 * - Gemini / unknown: 自然言語
 *
 * provider 名は session.provider の値. unknown は安全側に倒して
 * 自然言語にする (slash command でない方が誤発火が少ない).
 * 短縮形 ("claude" / "codex" 等) も寛容に受ける.
 */
export function pickSessionEndInjectText(provider: string): string {
  if (provider === "claude-code" || provider === "claude") {
    return "/session-end";
  }
  if (provider === "codex-cli" || provider === "codex") {
    return "$session-end";
  }
  return "session-end してください";
}

/**
 * active session に対して session-end inject event を emit する.
 * status が active でない場合や session が無い場合は no-op (false を返す).
 */
export function emitAutoSessionEndInject(session: SessionRow): boolean {
  if (session.status !== "active") return false;
  const text = pickSessionEndInjectText(session.provider);
  eventBus.emit({
    type: "session.inject",
    target_session_id: session.id,
    text,
    source: AUTO_SESSION_END_INJECT_SOURCE,
    ts: Math.floor(Date.now() / 1000),
  });
  return true;
}
