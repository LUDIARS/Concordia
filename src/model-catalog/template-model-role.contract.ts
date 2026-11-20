/**
 * C-1: 役割名は role map の ID (+ 接尾辞) に解決され、 明示 ID はそのまま、 解決できない役割は止まる。
 * 古い ID へ黙って戻す経路 (役割名なのに ok:true で role map 以外の値) が無いことを観測する。
 * 述語は実装を import しない (循環を作らず、 実装と独立に判定するため)。
 */
type Resolution = { ok: true; model: string | null; role: string | null } | { ok: false; error: string };
type Roles = { claude: Record<string, string>; codex: Record<string, string> };

const ROLE_NAME = /^(opus|sonnet|haiku|fable|sol|astra|luna)(\[1m\])?$/;

export default {
  post(result: Resolution, input: { provider: string; model: string | null | undefined; roles: Roles }): boolean {
    const match = ROLE_NAME.exec((input.model ?? "").trim().toLowerCase());
    if (!match) return result.ok && result.model === (input.model ?? null) && result.role === null;
    if (!result.ok) return result.error.startsWith("delegation_model_role_unresolved:");
    const family = input.provider === "claude" ? "claude" : "codex";
    return result.role === match[1] && result.model === `${input.roles[family][match[1]!]}${match[2] ?? ""}`;
  },
};
