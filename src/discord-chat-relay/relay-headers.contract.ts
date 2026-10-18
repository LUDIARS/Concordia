/** @implements spec/feature/discord-chat-relay.md — 転送 (dcr-C-3) */
const ALLOWED = new Set(["content-type", "authorization", "x-concordia-discord-target", "content-length", "host"]);

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!result || typeof result !== "object") return false;
    const target = args[0] as { name?: unknown; host?: unknown } | undefined;
    const relayToken = args[1];
    const bodyBytes = args[2];
    const headers = result as Record<string, unknown>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    const hostOnlyWhenSet = names.includes("host") === (typeof target?.host === "string" && target.host !== "");
    return names.every((name) => ALLOWED.has(name))
      && hostOnlyWhenSet
      && headers["content-type"] === "application/json"
      && headers.authorization === `Bearer ${String(relayToken)}`
      && headers["x-concordia-discord-target"] === target?.name
      && headers["content-length"] === String(bodyBytes);
  },
};
