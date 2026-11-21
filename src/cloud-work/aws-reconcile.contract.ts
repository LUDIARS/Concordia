type Job = { job_id: string; target_id: string; runner: string };
type Identity = { requestId: string; targetId: string; runner: string };

export default {
  post(result: unknown, jobs: Job[], identity: Identity): boolean {
    const keyed = jobs.filter(job => job.job_id === identity.requestId);
    return result === (keyed.length === 1 && keyed[0]?.target_id === identity.targetId
      && keyed[0].runner === identity.runner ? keyed[0] : undefined);
  },
};
