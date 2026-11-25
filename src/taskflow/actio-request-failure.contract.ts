/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-01 */
export default {
  post(result: unknown, method: unknown, timedOut: unknown, invalidJson: unknown): boolean {
    if (method === "POST" || method === "PATCH") {
      return result === "Actio task request outcome unknown; reconcile using the same task identity";
    }
    if (timedOut) return result === "Actio read timed out";
    if (invalidJson) return result === "Invalid Actio read response";
    return result === "Actio read connection failed";
  },
};
