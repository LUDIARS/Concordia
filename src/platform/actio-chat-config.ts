// @implements CC-ACTIO-CHAT-01
/** Only this named setting crosses the encrypted runtime-config boundary. */
export function readActioChatSecret(env: Readonly<Record<string, string | undefined>>): string {
  if (env.ACTIO_CHAT_SHARED_SECRET !== undefined) return env.ACTIO_CHAT_SHARED_SECRET;
  const raw = env.EXCUBITOR_SERVICE_CONFIG_JSON;
  if (raw === undefined || raw.trim() === "") return "";
  try {
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    const value = (config as Record<string, unknown>).actioChatSharedSecret;
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error();
    return value;
  } catch { throw new Error("Invalid Actio chat runtime configuration"); }
}
