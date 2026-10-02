/** @implements CC-RV-LIST-SCOPE-01 */
/** C-2: a request aborted by its own deadline is timeout; any other transport failure is unreachable. */
export default {
  post(result: unknown, timedOut?: unknown): boolean {
    return result === (timedOut === true ? "timeout" : "unreachable");
  },
};
