export default {
  post(result: boolean, lastPostAt: number, now: number): boolean {
    return result === (now - lastPostAt >= 5 * 60 * 1000);
  },
};
