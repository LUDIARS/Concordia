export type ChoreProvider = "claude" | "codex";
export type ChoreStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "acknowledged" | "continuing" | "continued";
export interface Chore {
  id: string;
  request_key: string;
  prompt: string;
  provider: ChoreProvider;
  status: ChoreStatus;
  cwd: string;
  output: string;
  error: string | null;
  spawn_id: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  delivered_revision: number;
  discord_message_id: string | null;
}
export const CHORE_TIMEOUT_MS = 10 * 60 * 1000;
export const CHORE_OUTPUT_BYTES = 128 * 1024;
export function isChoreResult(status: ChoreStatus): boolean {
  return status === "succeeded" || status === "failed";
}
export function canChooseChore(status: ChoreStatus, action: "ok" | "continue"): boolean {
  return isChoreResult(status) || (action === "ok" && status === "interrupted");
}
export function parseChoreMessage(text: string): { prompt: string; provider: ChoreProvider } {
  const match = /^\s*\[(claude|codex)\]\s*/i.exec(text);
  return { provider: match?.[1].toLowerCase() === "codex" ? "codex" : "claude", prompt: text.slice(match?.[0].length ?? 0).trim() };
}
export function validateChoreInput(prompt: string, provider: string): void {
  if (!prompt.trim() || prompt.length > 16_000) throw new Error("依頼は1〜16000文字で入力してください。");
  if (provider !== "claude" && provider !== "codex") throw new Error("provider must be claude or codex");
}
