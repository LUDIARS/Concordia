import { ObservationStore } from "../cloud-observation/store.js";

/** Reads a provider worker's existing terminal report without creating or mutating the observation store. */
export function readHostedWorkerReport(env: NodeJS.ProcessEnv, targetId: string, attemptId: string) {
  if (env.CONCORDIA_CLOUD_OBSERVATION_ENABLED !== "true" || !env.CONCORDIA_ARTIFACT_ROOT) return null;
  try {
    const store = new ObservationStore(env.CONCORDIA_ARTIFACT_ROOT, true);
    try {
      const state = store.get(targetId, attemptId)?.state;
      if (!state || !["reported_finished", "reported_failed"].includes(state.phase)) return null;
      return { state: state.phase, reportedAt: state.lastReceivedAt };
    } finally { store.close(); }
  } catch { return null; /* A missing or unavailable observation is independent of provider and artifact status. */ }
}
