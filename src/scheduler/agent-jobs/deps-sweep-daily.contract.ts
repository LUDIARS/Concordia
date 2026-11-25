export default {
  post(result: { jobName: string; resultKind: string; body: string }): boolean {
    return result.jobName === "deps-sweep-daily" && result.resultKind === "提案"
      && result.body.includes("detail.items") && result.body.includes("detail.proposals");
  },
};
