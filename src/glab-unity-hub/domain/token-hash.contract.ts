/** @implements spec/feature/glab-unity-hub.md — C-2 hashToken (guh-C-2) */
import { createHash } from "node:crypto";

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [token] = args as [string];
    return typeof result === "string" && /^[0-9a-f]{64}$/.test(result)
      && result === createHash("sha256").update(token, "utf8").digest("hex")
      && (token.length < 8 || !result.includes(token));
  },
};
