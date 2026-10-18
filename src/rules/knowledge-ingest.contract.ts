/** @implements spec/feature/patrol-chat.md — 取り込みの失敗理由に秘密値を残さない (chat-knowledge-C-6) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const secrets = (args[1] as Array<string | null>).map((s) => s?.trim() ?? "").filter((s) => s.length >= 4);
    return typeof result === "string" && result.length <= 300 && secrets.every((s) => !result.includes(s));
  },
};
