export default {
  post(result: unknown, jobName: unknown): boolean {
    return result === (jobName === "quaestor-mail-sweep" || jobName === "kaizen-daily");
  },
};
