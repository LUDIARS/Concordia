export default {
  post(result: unknown, sessions: readonly { spawnId: string | null }[], spawnId: string | null): boolean {
    const matching = sessions.filter((session) => spawnId !== null && session.spawnId === spawnId);
    return matching.length === 1 ? result === matching[0] : result === null;
  },
};
