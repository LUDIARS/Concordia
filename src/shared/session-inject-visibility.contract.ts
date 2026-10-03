/** SEI-VIS-01/02: exact internal provenance only, never content inference. */
export default {
  post(result: boolean, source: unknown): boolean {
    return result === (source !== "auto:session-end");
  },
};
