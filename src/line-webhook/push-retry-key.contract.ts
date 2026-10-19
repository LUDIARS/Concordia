/** @implements spec/feature/line-webhook-relay.md — LINE push の再送キー (line-wh-C-17) */
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default {
  post(result: unknown): boolean {
    return typeof result === "string" && UUID_V5.test(result);
  },
};
