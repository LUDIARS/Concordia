/** @implements spec/feature/line-webhook-relay.md — 署名の検証 (line-wh-C-4) */
import { createHmac } from "node:crypto";

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [secret, body, signature] = args as [unknown, unknown, unknown];
    if (typeof secret !== "string" || secret === "" || typeof signature !== "string" || signature === ""
      || !(body instanceof Uint8Array)) {
      return result === false;
    }
    const expected = createHmac("sha256", secret).update(body).digest("base64");
    return result === (expected === signature);
  },
};
