export default {
  post(result: unknown, state: unknown, found: unknown): boolean {
    return found === true ? result === "edit"
      : state === "sending" ? result === "reconcile"
      : state === "ready" ? result === "missing"
      : result === "create";
  },
};
