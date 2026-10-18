/** @implements spec/feature/line-webhook-relay.md — 転送 (line-wh-C-3) */
const ALLOWED = new Set(["content-type", "authorization", "x-concordia-line-target", "content-length", "host"]);

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!result || typeof result !== "object") return false;
    const target = args[0] as { name?: unknown; host?: unknown } | undefined;
    const relayToken = args[1];
    const headers = result as Record<string, unknown>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    const hostOnlyWhenSet = names.includes("host") === (typeof target?.host === "string" && target.host !== "");
    return names.every((name) => ALLOWED.has(name))
      && hostOnlyWhenSet
      && headers["content-type"] === "application/json"
      && headers.authorization === `Bearer ${String(relayToken)}`
      && headers["x-concordia-line-target"] === target?.name;
  },
};
