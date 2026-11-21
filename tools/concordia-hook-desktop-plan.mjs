/**
 * デスクトップの Claude アプリのタスクのプラン更新 (update_plan / wrap_up) を、 hook の入力から見分ける
 * (spec/feature/desktop-plan-discord.md)。
 *
 * アプリはプランを MCP ツールで更新するので、 PostToolUse の tool_name で分かる。 中身は Concordia が解釈する
 * ので、 ここでは入力をそのまま渡す。
 */

/** Concordia の src/session-plan/plan-state.ts の SESSION_PLAN_EVENT_KIND と同じ値。 */
export const DESKTOP_PLAN_EVENT_KIND = "desktop_plan";
/** hook が観測専用で登録したデスクトップアプリのセッションの印 (metadata)。 */
export const DESKTOP_APP_METADATA_KEY = "desktop_app";

const PLAN_TOOLS = new Map([
  ["mcp__ccd_turn__update_plan", "update_plan"],
  ["mcp__ccd_turn__wrap_up", "wrap_up"],
]);

/** プラン更新の呼び出しなら `{ tool, input }`、 それ以外は null。 */
export function desktopPlanCall(ctx) {
  const tool = PLAN_TOOLS.get(ctx?.tool_name);
  const input = ctx?.tool_input;
  if (!tool || typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return { tool, input };
}
