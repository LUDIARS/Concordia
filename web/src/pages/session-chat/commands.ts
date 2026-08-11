/** @implements spec/feature/session-message-webui-chat.md — D4 chat commands */

export type ChatCommand = { kind: "inject"; text: string } | { kind: "stop" } | { kind: "rename"; text: string } | { kind: "enter" } | { kind: "stat" } | { kind: "error"; message: string };

export function parseChatCommand(raw: string): ChatCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "inject", text: raw };
  if (text === "/stop") return { kind: "stop" };
  if (text === "/enter") return { kind: "enter" };
  if (text === "/stat") return { kind: "stat" };
  if (text.startsWith("/rename ") && text.slice(8).trim()) return { kind: "rename", text: text.slice(8).trim() };
  return { kind: "error", message: `未知のコマンド: ${text.split(/\s/, 1)[0]}` };
}
