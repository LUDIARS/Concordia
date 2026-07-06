export type ChatMode = "embedded" | "off";

export function readChatMode(env: NodeJS.ProcessEnv = process.env): ChatMode {
  const raw = (env.CONCORDIA_CHAT_MODE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  // chat リレー (Discord/Slack) は backend 内 embedded で動く。 旧 "worker" 分離は
  // 不安定 (WS bridge 越しの interaction 遅延) だったため撤去し、 embedded へ集約。
  // event loop を重くしていた cost サンプリングのみ cost-worker で分離する。
  return "embedded";
}

export function chatEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readChatMode(env) === "embedded";
}
