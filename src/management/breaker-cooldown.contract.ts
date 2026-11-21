export default {
  post(result: boolean, openedAt: number | null, cooldownMs: number | null, now: number): boolean {
    if (openedAt === null || cooldownMs === null) return result === false;
    return result === (now >= openedAt + cooldownMs);
  },
};
