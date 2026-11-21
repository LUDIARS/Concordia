export default {
  post(action: string, state: { allocation: string; jobId?: string; stopRequested: boolean; cancelSent: boolean }, initial: boolean): boolean {
    if (!state.jobId) return action === (initial && !state.stopRequested && state.allocation === "unattempted" ? "submit" : "hold");
    return action === (state.stopRequested && !state.cancelSent ? "cancel" : "observe");
  },
};
