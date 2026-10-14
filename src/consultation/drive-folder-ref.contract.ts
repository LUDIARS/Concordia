/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-2: a folder reference yields an id only from a bare folder id or a drive.google.com folder URL over https;
 * the returned id only holds id characters, and anything else yields null.
 */
const ID = /^[A-Za-z0-9_-]{10,200}$/;

export default {
  post(result: unknown, input: unknown): boolean {
    if (typeof input !== "string") return result === null;
    if (result === null) return true;
    if (typeof result !== "string" || !ID.test(result)) return false;
    const text = input.trim();
    if (text === result) return true;
    try {
      const url = new URL(text);
      return url.protocol === "https:" && url.hostname === "drive.google.com" && text.includes(result);
    } catch {
      return false;
    }
  },
};
