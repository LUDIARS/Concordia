export default {
  post(result: unknown, previous: unknown, candidate: { complete: boolean }, revision: number, currentRevision: number): boolean {
    if (revision !== currentRevision) return result === previous;
    if (candidate.complete) return result === candidate;
    return (previous as { complete?: boolean } | undefined)?.complete === true
      ? result === previous
      : result === candidate;
  },
};
