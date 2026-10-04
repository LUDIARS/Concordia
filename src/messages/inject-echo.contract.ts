/** C-16: text and timestamps alone never prove delivery identity. */
export default {
  post(result: unknown, _content: unknown, _ts: unknown, deliveryId?: unknown): boolean {
    return typeof deliveryId === "string" && deliveryId.length > 0 || result === null;
  },
};
