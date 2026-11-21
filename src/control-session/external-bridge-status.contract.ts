type Observation = { configured: boolean; last_success_at: string | null; last_failure_at: string | null };
export default {
  post(status: string, input: Observation): boolean {
    if (!input.configured) return status === "unconfigured";
    if (input.last_failure_at && (!input.last_success_at || Date.parse(input.last_failure_at) >= Date.parse(input.last_success_at))) return status === "failed";
    if (input.last_success_at) return status === "healthy";
    return status === "unused";
  },
};
