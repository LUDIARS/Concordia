/** @implements spec/feature/line-webhook-relay.md — LINE push の認証 (line-wh-C-15) */
import { createHash } from "node:crypto";

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [storedHash, authorization] = args;
    const match = typeof authorization === "string" ? /^Bearer (\S+)$/.exec(authorization) : null;
    if (typeof storedHash !== "string" || storedHash === "" || !match) return result === false;
    const presented = createHash("sha256").update(match[1], "utf8").digest("hex");
    return result === (presented === storedHash);
  },
};
