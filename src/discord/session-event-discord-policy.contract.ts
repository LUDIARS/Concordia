export default {
  post(result: unknown, type: unknown): boolean {
    return result === (type === "session.stall_nudged");
  },
};
