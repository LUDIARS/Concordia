type Job = { release: string; kind: string; containers: Array<{ name: string; exit_code: number | null }>;
  provider_state: string | null; stop_requested_at: string | null };

export default {
  post(result: { resourceRelease: string; stopProgress: string; exitCode: number | null }, job: Job, container?: string): boolean {
    const released = ["confirmed", "not_allocated"].includes(job.release);
    const terminal = job.kind === "fargate" && ["STOPPED", "DELETED"].includes(job.provider_state ?? "");
    const exitCodes = job.containers.filter(entry => entry.name === container);
    const exitCode = terminal && exitCodes.length === 1 ? exitCodes[0]?.exit_code ?? null : null;
    return result.resourceRelease === (released ? "released" : "unknown")
      && result.stopProgress === (job.stop_requested_at ? released ? "confirmed" : "requested" : "none")
      && result.exitCode === exitCode;
  },
};
