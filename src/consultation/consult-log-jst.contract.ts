/** @implements SPEC-CONSULT-LOG */
/** C-4: timestamps are written in JST (UTC+9) as YYYY-MM-DD HH:mm:ss. */
export default {
  post(result: unknown, ms: unknown): boolean {
    if (typeof result !== "string" || typeof ms !== "number" || !Number.isFinite(ms)) return false;
    const jst = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
    return result === `${jst.slice(0, 10)} ${jst.slice(11, 19)}`;
  },
};
