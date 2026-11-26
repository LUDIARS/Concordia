export default {
  post(result: unknown, method: string, reason: string, attempt: number, remainingMs: number, status?: number): boolean {
    const retry = method === "GET" && attempt === 1 && remainingMs > 150 && (
      reason === "actio_unreachable" || reason === "actio_read_timeout" ||
      (reason === "actio_request_rejected" && (status === 502 || status === 503 || status === 504))
    );
    return result === (retry ? 150 : null);
  },
};
