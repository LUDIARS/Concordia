/** @implements spec/feature/line-webhook-relay.md — 転送 (line-wh-C-3) */
const ALLOWED = new Set(["content-type", "x-line-signature", "content-length", "host"]);

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!result || typeof result !== "object") return false;
    const target = args[1] as { host?: unknown } | undefined;
    const names = Object.keys(result).map((name) => name.toLowerCase());
    const leaks = names.some((name) =>
      name.startsWith("cf-") || name.startsWith("x-forwarded-") || name === "cookie" || name === "authorization");
    const hostOnlyWhenSet = names.includes("host") === (typeof target?.host === "string" && target.host !== "");
    return !leaks && hostOnlyWhenSet && names.every((name) => ALLOWED.has(name));
  },
};
