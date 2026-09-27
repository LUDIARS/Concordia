// @implements CC-ACTIO-CHAT-01
export interface ChatProxyRequest {
  teamId: string; platform: "discord" | "slack"; workspaceId: string;
  path: string; method: "GET" | "POST" | "PATCH"; body?: Record<string, unknown>;
}
const slackMethods = new Set(["auth.test", "conversations.info", "conversations.history", "conversations.replies", "conversations.list", "conversations.create", "conversations.setTopic", "conversations.archive", "chat.postMessage"]);
export function allowedChatRequest(input: ChatProxyRequest): boolean {
  if (input.platform === "slack") return input.method === "POST" && slackMethods.has(input.path);
  if (!/^\d{5,25}$/.test(input.workspaceId) || /[\\#]/.test(input.path)) return false;
  const path = input.path.split("?")[0];
  if (path.includes("%")) return false;
  if (input.method === "GET") return path === "/users/@me"
    || path === `/guilds/${input.workspaceId}/channels` || path === `/guilds/${input.workspaceId}/threads/active`
    || /^\/channels\/\d{5,25}(?:\/messages(?:\/\d{5,25})?|\/threads\/archived\/public)?$/.test(path);
  if (input.method === "POST") return path === `/guilds/${input.workspaceId}/channels`
    || /^\/channels\/\d{5,25}\/messages(?:\/\d{5,25}\/threads)?$/.test(path);
  return input.method === "PATCH" && /^\/channels\/\d{5,25}$/.test(path);
}
