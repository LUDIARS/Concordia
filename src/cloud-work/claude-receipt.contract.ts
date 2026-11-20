export default {
  post(result: { state: string; remoteId?: string }, state: string, remoteId: string): boolean {
    return result.state === state && result.remoteId === remoteId && /^(session|cse)_/.test(remoteId);
  },
};
