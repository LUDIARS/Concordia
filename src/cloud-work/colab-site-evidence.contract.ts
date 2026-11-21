export default {
  post(result: { resourceRelease: string; stopProgress: string }, receipt: { phase: string; outcome: string | null }, stopRequested: boolean): boolean {
    const stopped = receipt.phase === "released" && receipt.outcome === "cancelled";
    return (result.resourceRelease === "released") === (receipt.phase === "released")
      && result.stopProgress === (stopped ? "confirmed" : stopRequested ? "requested" : "none");
  },
};
