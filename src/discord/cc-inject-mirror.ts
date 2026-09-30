/**
 * Cc 由来 inject の Discord 転記 — 転記可否と文面の組み立て (純関数、 I/O なし)。
 *
 * 背景: Cc が自分で入れる inject (作業ポリシー更新 / テスト交通整備 / 委託の状態通知 /
 * auto:inquiry / director / reaction workflow / session end の insurance など) は PTY に
 * 入るだけで Discord にも transcript にも残らなかった。 遠隔から「Cc がセッションに何を
 * 伝えたか」を追えるよう、 session thread へ転記する。
 *
 * 他経路が既に見せているもの (Discord 人間発言・Enter 制御・Slack 人間発言・委託タスク本文)
 * と、 本文を出さない方針の自動確認 (stall nudge) は転記しない。
 *
 * spec/feature/discord-session-task-post.md §3.6。
 */

import { ENTER_KEY_TEXT } from "../platform/enter-key.js";
import { parseInjectSource } from "../shared/inject-source.js";
import { taskKindForInjectSource } from "./session-task-post.js";

/**
 * 自動確認 (stall nudge) の inject source。 正本は `src/control/stalled-session-nudge.ts` の
 * `STALL_NUDGE_SOURCE`。 discord/ → control/ の import は dependency-cruiser で禁止なので値を写す。
 * 自動確認は本文を出さず事実だけ通知する (2026-08-25 neco 指示)。
 */
export const STALL_NUDGE_INJECT_SOURCE = "auto:stall-nudge";

/** Discord message 本文の上限 (2000) に余裕を持たせた転記上限。 */
export const CC_INJECT_MIRROR_MAX_CONTENT = 1900;
/** Discord webhook username の上限。 */
export const CC_INJECT_MIRROR_MAX_USERNAME = 80;

const TRUNCATED_SUFFIX = "\n…(以下省略)";

export interface CcInjectMirrorPost {
  username: string;
  content: string;
}

function isDiscordOrigin(source: string): boolean {
  return source === "discord" || source === "discord-enter" || source.startsWith("discord:");
}

/** Cc 由来 inject を転記する文面。 転記しないものは null。 */
export function ccInjectMirrorPost(input: {
  source: string | null | undefined;
  text: string;
}): CcInjectMirrorPost | null {
  const source = (input.source ?? "").trim();
  if (input.text === ENTER_KEY_TEXT) return null;
  const text = input.text.trim();
  if (!text) return null;
  if (isDiscordOrigin(source)) return null;
  if (parseInjectSource(source).platform !== null) return null;
  if (taskKindForInjectSource(source) !== null) return null;
  if (source === STALL_NUDGE_INJECT_SOURCE) return null;

  const username = `⚙️ Cc inject / ${source || "unknown"}`.slice(0, CC_INJECT_MIRROR_MAX_USERNAME);
  const content = text.length > CC_INJECT_MIRROR_MAX_CONTENT
    ? text.slice(0, CC_INJECT_MIRROR_MAX_CONTENT - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
    : text;
  return { username, content };
}
