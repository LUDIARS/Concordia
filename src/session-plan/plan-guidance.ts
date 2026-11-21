/**
 * プランを自分で持たないエージェントへ、 プランの送り方を起動案内で伝える (spec/feature/session-plan-discord.md)。
 * Claude Code 系 (デスクトップアプリは hook が自動で送る) には何も足さない。
 *
 * @implements SPEC-SESSION-PLAN-DISCORD
 */

import { fileURLToPath } from "node:url";

/** プランを CLI で送らせる provider。 */
const CLI_PLAN_PROVIDERS: ReadonlySet<string> = new Set(["antigravity-cli"]);

/** 送り口の CLI (tools/session-plan.mjs) の絶対パス。 */
export const SESSION_PLAN_CLI = fileURLToPath(new URL("../../tools/session-plan.mjs", import.meta.url)).replace(/\\/g, "/");

/** 起動案内に足すプランの送り方。 対象外の provider では空文字。 */
export function sessionPlanGuidance(provider: string, cli: string = SESSION_PLAN_CLI): string {
  if (!CLI_PLAN_PROVIDERS.has(provider)) return "";
  const run = `node "${cli}"`;
  return [
    "[Cc session plan] 複数の手順がある作業は、 着手前にプランを送ってください。 手順が進むたびに更新し、 終わったら wrap-up を送ってください。 短い返答や 1 手順で済む作業はプラン不要です。",
    `- プランを出す: JSON ファイル {"items":[{"content":"調べる","status":"in_progress"},{"content":"直す","status":"pending"}]} を書き、 ${run} update --file=<そのファイル>`,
    `- 進める: ${run} update --json='{"advance":true}' (番号で完了・開始は {"done":[2],"start":3}、 全体の置き換えは items)`,
    `- 終える: ${run} wrap-up --json='{"recap":"<要約>"}' (人の回答を待つなら "ask":"<質問>","blocked":true を足す)`,
    "- 非 0 で終わったら stderr の理由を読んで直してください。 送れていないまま進めないでください。",
  ].join("\n");
}
