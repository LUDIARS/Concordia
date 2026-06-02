// Slack slash command (`/concordia <sub>`) のディスパッチ。
// Socket Mode の slash_commands envelope から呼ばれる。v0.2 は読み取り系のみ
// (stat / prs / help)。spawn/end 等の副作用系はフォローアップ。
// 宛先は Discord コマンドと同じ Concordia HTTP API。

import { parseSlashCommand } from "./render.js";

export interface SlashDeps {
  concordiaUrl: string;
}

/** stat の enriched item（必要フィールドだけ緩く拾う）。 */
interface StatItem {
  session_id?: string;
  session?: { status?: string; current_task?: string | null; branch?: string | null } | null;
}

/** `/v1/stat` の items を 1 行ずつの要約に整形（純粋）。 */
export function formatStat(items: StatItem[]): string {
  if (!items.length) return "アクティブな stat はありません。";
  const lines = items.slice(0, 30).map((it) => {
    const sid = (it.session_id ?? "????????").slice(0, 8);
    const st = it.session?.status ?? "?";
    const task = (it.session?.current_task ?? "").trim();
    const branch = (it.session?.branch ?? "").trim();
    const tail = task || branch || "(no task)";
    return `• \`${sid}\` [${st}] ${tail}`;
  });
  return `*セッション現況 (${items.length})*\n${lines.join("\n")}`;
}

export function formatHelp(): string {
  return [
    "*Concordia slash*",
    "• `/concordia stat` — 全セッションの現況",
    "• `/concordia prs` — PR キュー",
    "• `/concordia help` — このヘルプ",
    "_(セッションへの入力はスレッド返信、質問回答はボタンで)_",
  ].join("\n");
}

/** slash command 本文を処理して返信テキストを返す。失敗は人間向けメッセージに丸める。 */
export async function runSlackSlash(deps: SlashDeps, text: string): Promise<string> {
  const { sub, args } = parseSlashCommand(text);
  try {
    if (sub === "stat") {
      const res = await fetch(`${deps.concordiaUrl}/v1/stat`);
      if (!res.ok) return `stat 取得失敗 (${res.status})`;
      const json = (await res.json()) as { items?: StatItem[] };
      return formatStat(json.items ?? []);
    }
    if (sub === "prs" || sub === "pr") {
      const res = await fetch(`${deps.concordiaUrl}/v1/prs/digest`);
      if (!res.ok) return `PR キュー取得失敗 (${res.status})`;
      const json = (await res.json()) as { markdown?: string };
      const md = (json.markdown ?? "").trim();
      return md || "PR はありません。";
    }
    if (sub === "help" || !sub) return formatHelp();
    return `未知のサブコマンド: \`${sub}\`${args ? ` ${args}` : ""}\n${formatHelp()}`;
  } catch (e) {
    return `エラー: ${(e as Error).message}`;
  }
}
