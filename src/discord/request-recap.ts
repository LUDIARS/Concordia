/**
 * セッション起動時に依頼内容を投稿し直すための文面 (2026-10-13 依頼)。
 *
 * フォーラム起動ではスレッド名が変わり、本文は会話に流されて読めなくなる。
 * 相談のプライベートチャンネルはモーダルの入力がどこにも残らない。
 * どちらも起動直後に「何を頼まれたか」を 1 通で残す。
 *
 * 人の書いた文を Bot が再掲するので、メンションは壊して実発火させない。
 * Discord の 1 投稿の上限 (2000 文字) に収め、切ったときは省略を明示する。
 */

import type { ConsultIntake } from "../dialogue/intake.js";
import { CONSULT_INTAKE_LABELS } from "../dialogue/intake.js";
import { clampText, sanitizeMentions } from "./embed-limits.js";

/** 投稿の上限 (Discord 2000 文字) より少し手前。 */
export const REQUEST_RECAP_MAX_LENGTH = 1900;

const CONSULT_FIELD_ORDER: readonly (keyof ConsultIntake)[] = ["topic", "skill_level", "role_title", "purpose"];

/** フォーラム起動: スレッドのタイトルと最初の投稿の本文。 */
export function formatForumRequestRecap(input: { title: string; body: string }): string {
  const title = sanitizeMentions(input.title.trim()) || "(タイトルなし)";
  const head = ["📝 **依頼内容**", `**タイトル**: ${title}`, "**本文**:"].join("\n");
  const body = sanitizeMentions(input.body.trim()) || "(本文なし)";
  return head + "\n" + clampText(body, REQUEST_RECAP_MAX_LENGTH - head.length - 1);
}

/** 相談: 部署 (タイトル) と、モーダルで入力した相談内容・オプション。 空の任意項目は「未入力」と書く。 */
export function formatConsultRequestRecap(input: { departmentName: string | null; intake: ConsultIntake }): string {
  const lines = ["📝 **相談内容**"];
  if (input.departmentName) lines.push(`**部署**: ${sanitizeMentions(input.departmentName)}`);
  // 知りたいこと (本文) は最後に置き、長いときはそこだけを切り詰める。
  for (const field of CONSULT_FIELD_ORDER) {
    if (field === "topic") continue;
    const value = sanitizeMentions(input.intake[field]?.trim() ?? "");
    lines.push(`**${CONSULT_INTAKE_LABELS[field]}**: ${value || "未入力"}`);
  }
  lines.push(`**${CONSULT_INTAKE_LABELS.topic}**:`);
  const head = lines.join("\n");
  const topic = sanitizeMentions(input.intake.topic?.trim() ?? "") || "未入力";
  return head + "\n" + clampText(topic, REQUEST_RECAP_MAX_LENGTH - head.length - 1);
}
