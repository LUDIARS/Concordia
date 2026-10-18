/** @implements spec/feature/line-webhook-relay.md — 振り分け (line-wh-C-8) */
const SPACES = new Set([" ", "\t", "　"]);
const isDigit = (ch: string) => (ch >= "0" && ch <= "9") || (ch >= "０" && ch <= "９");

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const text = typeof args[0] === "string" ? args[0] : "";
    // Spelled out character by character instead of reusing the implementation's pattern.
    let expected = text.startsWith("つなぐ");
    let digits = 0;
    if (expected) {
      for (const ch of text.slice("つなぐ".length)) {
        if (isDigit(ch)) digits += 1;
        else if (!SPACES.has(ch)) { expected = false; break; }
      }
    }
    return result === (expected && digits > 0);
  },
};
