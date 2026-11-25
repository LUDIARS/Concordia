export default {
  post(result: unknown, sessionId: string | null, ts: number): boolean {
    if (sessionId !== null) return result === null;
    if (!result || typeof result !== "object") return false;
    return "type" in result && result.type === "ping"
      && "v" in result && result.v === 1 && "ts" in result && result.ts === ts;
  },
};
