/**
 * Cc 由来 inject の Discord 転記 — 転記可否と文面の組み立て (純関数、 I/O なし)。
 *
 * 背景: Cc が自分で入れる inject (作業ポリシー更新 / テスト交通整備 / 委託の状態通知 /
 * auto:inquiry / director / reaction workflow など) は PTY に
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
import { shouldDisplaySessionInject } from "../shared/session-inject-visibility.js";
import { taskKindForInjectSource } from "./session-task-post.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:71e98731 */
import augurContract_3fb7485d from './cc-inject-mirror.contract.js'; /* augur-inject:contract-predicate:34b1aaee */

/**
 * 自動確認 (stall nudge) の inject source。 正本は `src/control/stalled-session-nudge.ts` の
 * `STALL_NUDGE_SOURCE`。 discord/ → control/ の import は dependency-cruiser で禁止なので値を写す。
 * 自動確認は本文を出さず事実だけ通知する (2026-08-25 neco 指示)。
 */
export const STALL_NUDGE_INJECT_SOURCE = "auto:stall-nudge";

/** 1 行通知の上限 (これを超えたら 149 文字 + `…`)。 */
export const CC_INJECT_SUMMARY_MAX = 150;
/** Discord webhook username の上限。 */
export const CC_INJECT_MIRROR_MAX_USERNAME = 80;

const TAGGED_LINE = /^\[([^\]]+)\]\s*(.*)$/;
const KEY_LINE = /^([A-Za-z][\w.-]*)\s*:/;
const MAX_SUMMARY_KEYS = 5;

export interface CcInjectMirrorPost {
  username: string;
  content: string;
}

function isDiscordOrigin(source: string): boolean {
  return source === "discord" || source === "discord-enter" || source.startsWith("discord:");
}

/** 後続行の `key: value` の key を出現順・重複除去で並べる (最大 5 個、 超えたら ` ほか`)。 */
function summarizeKeys(lines: readonly string[]): string {
  const keys: string[] = [];
  for (const line of lines) {
    const key = KEY_LINE.exec(line)?.[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return "";
  const head = keys.slice(0, MAX_SUMMARY_KEYS).join(" / ");
  return keys.length > MAX_SUMMARY_KEYS ? `${head} ほか` : head;
}

function firstLineSummary(lines: readonly string[]): string {
  const tagged = TAGGED_LINE.exec(lines[0] ?? "");
  if (!tagged) return lines[0] ?? "";
  const heading = tagged[1]!.trim();
  const rest = tagged[2]!.trim();
  const gist = rest || summarizeKeys(lines.slice(1)) || (lines[1] ?? "");
  return gist ? `${heading}: ${gist}` : heading;
}

/**
 * Cc 由来 inject 本文を 1 行の要旨にする。 `[タグ] 残り` 形の先頭行は `タグ: 要旨`、
 * それ以外は先頭行そのもの。 連続空白は 1 つに潰し、 150 文字を超えたら 149 文字 + `…`。
 */
export function summarizeCcInject(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = firstLineSummary(lines).replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > CC_INJECT_SUMMARY_MAX
    ? chars.slice(0, CC_INJECT_SUMMARY_MAX - 1).join("") + "…"
    : line;
}
// @ts-expect-error augur-inject
summarizeCcInject = contract(summarizeCcInject, { ...augurContract_3fb7485d, contractId: 'C-12', mode: 'observe', sample: 1, where: 'src/discord/cc-inject-mirror.ts:69', rule: 'contract-wrap', id: '3fb7485d' }); /* augur-inject:contract-wrap:3fb7485d */

/** 中身が失敗・異常の知らせである inject の source (本文によらずエラー扱い)。 */
const ERROR_INJECT_SOURCES: ReadonlySet<string> = new Set(["error-autofix", "budget-exhausted", "auto:delegation-watchdog"]);
/** 1 行要旨にこれが含まれればエラーの知らせとみなす (Revisor の審査失敗・衝突など)。 */
const ERROR_SUMMARY = /失敗|エラー|拒否|衝突|\b(error|errors|fail|failed|failure|rejected|conflict)\b/i;

/**
 * 部署の出力方針で Cc の指令の転記を切っていても出す、 エラーの知らせか
 * (2026-10-10 neco 指示: 総務は Cc inject を出さない、 エラーの通知はする)。
 */
export function isErrorCcInject(input: { source: string | null | undefined; text: string }): boolean {
  if (ERROR_INJECT_SOURCES.has((input.source ?? "").trim())) return true;
  return ERROR_SUMMARY.test(summarizeCcInject(input.text));
}

/**
 * Cc 由来 inject を転記する文面。 転記しないものは null。
 * `injectTranscript: false` (部署の出力方針 `inject_transcript` が off) のときは、
 * エラーの知らせだけを転記する。 内容は Cc の WebUI のセッション画面で見る。
 */
export function ccInjectMirrorPost(input: {
  source: string | null | undefined;
  text: string;
  injectTranscript?: boolean;
}): CcInjectMirrorPost | null {
  if (!shouldDisplaySessionInject(input.source)) return null;
  const source = (input.source ?? "").trim();
  if (input.text === ENTER_KEY_TEXT) return null;
  const text = input.text.trim();
  if (!text) return null;
  if (isDiscordOrigin(source)) return null;
  if (parseInjectSource(source).platform !== null) return null;
  if (taskKindForInjectSource(source) !== null) return null;
  if (source === STALL_NUDGE_INJECT_SOURCE) return null;
  if (input.injectTranscript === false && !isErrorCcInject({ source, text })) return null;

  const username = `⚙️ Cc inject / ${source || "unknown"}`.slice(0, CC_INJECT_MIRROR_MAX_USERNAME);
  return { username, content: summarizeCcInject(text) };
}
