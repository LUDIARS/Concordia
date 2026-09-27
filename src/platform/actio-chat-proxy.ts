// @implements CC-ACTIO-CHAT-01
import { allowedChatRequest, type ChatProxyRequest } from "./actio-chat-policy.js";
export interface ChatProxyCredentials { token: string; workspaceId?: string }
export interface ChatProxyDeps {
  credentials(input: ChatProxyRequest): ChatProxyCredentials | null;
  request?: typeof fetch;
}
export async function proxyChat(input: ChatProxyRequest, deps: ChatProxyDeps, signal: AbortSignal): Promise<Response> {
  if (!allowedChatRequest(input)) return Response.json({ error: "unsupported chat operation" }, { status: 400 });
  const credentials = deps.credentials(input);
  if (!credentials?.token) return Response.json({ error: "chat credentials or team scope unavailable" }, { status: 403 });
  const request = deps.request ?? fetch;
  const headers = { authorization: `${input.platform === "discord" ? "Bot" : "Bearer"} ${credentials.token}`, "content-type": "application/json; charset=utf-8" };
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  if (input.platform === "discord") {
    if (credentials.workspaceId !== input.workspaceId) return Response.json({ error: "guild mismatch" }, { status: 403 });
    const channel = input.path.match(/^\/channels\/(\d+)/)?.[1];
    const parent = input.body?.parent_id;
    for (const id of [channel, typeof parent === "string" ? parent : undefined].filter(Boolean)) {
      const check = await request(`https://discord.com/api/v10/channels/${id}`, { headers, redirect: "error", signal: boundedSignal });
      if (!check.ok) return Response.json({ error: "channel unavailable" }, { status: check.status });
      const value = await check.json() as { guild_id?: string };
      if (value.guild_id !== input.workspaceId) return Response.json({ error: "channel guild mismatch" }, { status: 403 });
    }
  } else {
    const check = await request("https://slack.com/api/auth.test", { method: "POST", headers, redirect: "error", signal: boundedSignal });
    if (!check.ok) return Response.json({ error: "Slack identity unavailable" }, { status: check.status });
    const identity = await check.json() as { ok?: boolean; team_id?: string };
    if (!identity.ok || identity.team_id !== input.workspaceId) return Response.json({ error: "Slack workspace mismatch" }, { status: 403 });
  }
  const url = input.platform === "discord" ? `https://discord.com/api/v10${input.path}` : `https://slack.com/api/${input.path}`;
  // Never retry mutations here. Actio retains the operation and reconciles a lost response.
  const result = await request(url, { method: input.method, headers, redirect: "error", signal: boundedSignal,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
  return new Response(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "no-store", ...(result.headers.get("retry-after") ? { "retry-after": result.headers.get("retry-after")! } : {}) } });
}
