/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-02 */
const pageReasons = new Set(["actio_read_timeout", "actio_unreachable", "actio_response_invalid"]);

export default {
  post(result: unknown, completedPages: number, code: string): boolean {
    const expected = completedPages > 0 && pageReasons.has(code) ? code : undefined;
    return result === expected;
  },
};
