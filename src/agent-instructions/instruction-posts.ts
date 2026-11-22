/**
 * 「muse-指令」チャンネルへ出す文 (spec/feature/agent-instructions-bridge.md CC-INST-INV-08 / INV-09)。 純関数。
 *
 * 題・本文・回答は信頼できない入力として扱う (回答は Muse から来る)。 mention (@everyone / @here / <@...>) と
 * リンクの自動展開にならないよう無効化し、 送信側でも allowedMentions を空にする (二重)。 鍵・秘密は入れない
 * (指令の行に鍵は無く、 載せるのは id・type・題・本文の要約・回答だけ)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 指令チャンネルの文
 */

import type { InstructionEvent } from "./instruction-events.js";

/** Discord の 1 投稿の上限 2000 文字に余白を残す。 */
export const INSTRUCTION_POST_MAX_CHARS = 1900;
export const INSTRUCTION_POST_BODY_CHARS = 300;
export const INSTRUCTION_POST_DETAIL_CHARS = 1500;
const SUMMARY_CHARS = 400;
const ZERO_WIDTH_SPACE = "​";

export interface InstructionPost {
  /** 投稿の本文。 */
  content: string;
  /** 返信先にする指令の id (登録の投稿へぶら下げる)。 登録の投稿そのものは null。 */
  replyTo: string | null;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function defuse(text: string): string {
  return text
    .replace(/@/gu, `@${ZERO_WIDTH_SPACE}`)
    .replace(/<(?=[@#:&!])/gu, `<${ZERO_WIDTH_SPACE}`)
    .replace(/https?:\/\//giu, (scheme) => `${scheme.slice(0, -2)}${ZERO_WIDTH_SPACE}//`);
}

/** 1 行に潰して切り詰め、 無害化する (題・要約)。 */
export function neutralizeLine(text: string, max: number): string {
  return defuse(clip(text.replace(/\s+/gu, " ").trim(), max));
}

/** 改行は残して切り詰め、 無害化する (本文)。 引用ブロックの各行にする。 */
function quoteBlock(text: string, max: number): string {
  return defuse(clip(text.trim(), max)).split(/\r?\n/u).map((line) => `> ${line}`).join("\n");
}

/** 回答の詳細 (canonical JSON) を読みやすく整形してコードブロックにする。 コードブロックを閉じさせない。 */
export function detailBlock(detail: string | null, max: number): string | null {
  if (detail === null || max <= 0) return null;
  let pretty = detail;
  try { pretty = JSON.stringify(JSON.parse(detail), null, 2); } catch { /* 保存値をそのまま出す */ }
  const safe = defuse(clip(pretty, max)).replace(/```/gu, `\`${ZERO_WIDTH_SPACE}\`\``);
  return `\`\`\`json\n${safe}\n\`\`\``;
}

/** 宛先の表示名。 許可リスト外 (来ないはず) は無害化してそのまま出す。 */
export function agentLabel(agent: string): string {
  if (agent === "muse") return "Muse";
  if (agent === "dots") return "dots";
  return neutralizeLine(agent, 32);
}

function code(id: string): string {
  return `\`${id.replace(/`/gu, "")}\``;
}

export function buildInstructionPost(event: InstructionEvent): InstructionPost {
  const who = agentLabel(event.agent);
  switch (event.kind) {
    case "registered": {
      const lines = [
        `📨 **指令を出しました** ${code(event.id)}`,
        `宛先: ${who} / 種類: ${neutralizeLine(event.type, 40)} / 作成: ${event.createdAt}`,
        `題: ${neutralizeLine(event.title, 200)}`,
        quoteBlock(event.body, INSTRUCTION_POST_BODY_CHARS),
      ];
      return { content: clip(lines.join("\n"), INSTRUCTION_POST_MAX_CHARS), replyTo: null };
    }
    case "acked":
      return { content: `📥 ${who} が受け取りました ${code(event.id)} (${event.ackedAt})`, replyTo: event.id };
    case "requeued":
      return {
        content: `↩️ ${code(event.id)} は受領から 30 分回答が無いため、 再配信待ち (pending) に戻しました`,
        replyTo: event.id,
      };
    case "finished": {
      const mark = event.status === "done" ? "✅" : "❌";
      const head = [
        `${mark} **${who} の回答** ${code(event.id)} — ${event.status} (${event.finishedAt})`,
        `題: ${neutralizeLine(event.title, 200)}`,
        `要約: ${neutralizeLine(event.summary, SUMMARY_CHARS)}`,
      ].join("\n");
      // 詳細はコードブロックごと上限に収める (途中で切ってブロックを壊さない)。
      const room = Math.min(INSTRUCTION_POST_DETAIL_CHARS, INSTRUCTION_POST_MAX_CHARS - head.length - 20);
      const block = detailBlock(event.detail, room);
      return { content: block ? `${head}\n${block}` : head, replyTo: event.id };
    }
  }
}
