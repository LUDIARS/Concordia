/**
 * C-1: 役割名は role map の ID (+ 接尾辞) に解決され、 明示 ID はそのまま、 解決できない役割は止まる。
 * 古い ID へ黙って戻す経路 (役割名なのに ok:true で role map 以外の値) が無いことを観測する。
 * 述語は実装を import しない (循環を作らず、 実装と独立に判定するため)。
 */
type Resolution = { ok: true; model: string | null; role: string | null } | { ok: false; error: string };
type Roles = { claude: Record<string, string>; codex: Record<string, string>; gemini: Record<string, string>; grok: Record<string, string> };

const ROLE_NAME = /^(opus|sonnet|haiku|fable|sol|astra|luna|neon|argon|grok)(\[1m\])?$/;

export default {
  post(result: Resolution, input: { provider: string; model: string | null | undefined; roles: Roles }): boolean {
    const defaultRole = input.provider === "agy" ? "neon" : input.provider === "grok" ? "grok" : "";
    const requested = input.model?.trim() || defaultRole;
    const match = ROLE_NAME.exec((requested ?? "").trim().toLowerCase());
    if (!match) return result.ok && result.model === (input.model ?? null) && result.role === null;
    const family = input.provider === "claude" ? "claude"
      : input.provider === "gemini" || input.provider === "agy" ? "gemini"
      : input.provider === "grok" ? "grok"
      : input.provider === "codex" || input.provider === "codex-sdk" ? "codex" : null;
    const role = match[1]!;
    const suffix = match[2] ?? "";
    const roleFamily = /^(opus|sonnet|haiku|fable)$/.test(role) ? "claude"
      : /^(sol|astra|luna)$/.test(role) ? "codex" : role === "grok" ? "grok" : "gemini";
    const model = family === roleFamily ? input.roles[family][role]?.trim() : undefined;
    if (!model || (family !== "claude" && suffix)) {
      return !result.ok && result.error.startsWith("delegation_model_role_unresolved:");
    }
    return result.ok && result.role === role && result.model === `${model}${suffix}`;
  },
};
