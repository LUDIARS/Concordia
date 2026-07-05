export type ChatMode = "embedded" | "worker" | "off";

export function readChatMode(env: NodeJS.ProcessEnv = process.env): ChatMode {
  const raw = (env.CONCORDIA_CHAT_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "worker") return raw;
  return "embedded";
}

export function chatEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readChatMode(env) === "embedded";
}
