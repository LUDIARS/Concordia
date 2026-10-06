/**
 * 人間依頼マーカー (```human-command フェンス) の解釈。
 *
 * 分類器に止められて人間が打つしかないコマンドを、セッションは次の形で出す:
 *
 *     ```human-command
 *     {"description":"なぜ必要か","command":"gh auth login"}
 *     ```
 *
 * Discord はメッセージの一部だけをコピーしにくいので、Cc はこのマーカーを拾って
 * コマンドだけの投稿を「人間依頼」チャンネルへ出す (human-request.ts)。
 *
 * @implements spec/feature/human-request-channel.md §2
 */

export interface HumanCommandRequest {
  description: string;
  command: string;
}

const FENCE_RE = /(^|\n)[ \t]*```human-command[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
/** Discord の 1 投稿上限 (2000) に説明・注記の余白を残す。 */
export const MAX_COMMAND_LENGTH = 1900;
export const MAX_DESCRIPTION_LENGTH = 1500;

/**
 * Claude Code が人に手動で打ってもらうときの書き方「`! <command>`」(バッククォートの中が `! ` で始まる)。
 * セッションがマーカーを出さずにこの形で頼むことが多いので拾う (2026-10-06 neco 指示「実行する必要があるコマンドを
 * まとめるチャンネル」)。`!` の直後に空白が要る (`!important` のような語を拾わない)。
 */
const BANG_RE = /`!\s+([^`\n]+)`/g;
const MAX_BANG_CONTEXT = 300;

/** 本文中の human-command マーカーと「`! <command>`」をすべて取り出す。壊れたマーカーは無視し、同じコマンドは 1 件にする。 */
export function parseHumanCommandRequests(text: string): HumanCommandRequest[] {
  const requests: HumanCommandRequest[] = [];
  const seen = new Set<string>();
  const push = (request: HumanCommandRequest | null) => {
    if (!request || seen.has(request.command)) return;
    seen.add(request.command);
    requests.push(request);
  };
  for (const match of text.matchAll(FENCE_RE)) push(parseBlock(match[2] ?? ""));
  // マーカーの中身 (JSON) に書かれた `! ...` は二重に拾わない。
  const outsideFences = text.replace(FENCE_RE, "\n");
  for (const line of outsideFences.split(/\r?\n/)) {
    for (const match of line.matchAll(BANG_RE)) {
      const command = (match[1] ?? "").trim();
      if (!command || command.length > MAX_COMMAND_LENGTH) continue;
      const context = line.replace(BANG_RE, "").replace(/\s+/g, " ").trim().slice(0, MAX_BANG_CONTEXT);
      push({ description: context, command });
    }
  }
  return requests;
}

function parseBlock(body: string): HumanCommandRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.command !== "string") return null;
  // Claude Code の `! <command>` 表記で渡されても、人間がそのまま貼れる形にする。
  const command = row.command.trim().replace(/^!\s*/, "").trim();
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  const description = typeof row.description === "string" ? row.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";
  return { description, command };
}
