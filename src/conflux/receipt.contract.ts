export default {
  post(result: unknown, stored: unknown, incoming: unknown): boolean {
    return result === (stored === undefined ? "new" : stored === incoming ? "same" : "conflict");
  },
};
