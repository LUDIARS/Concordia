/**
 * Resolve the Concordia session ID to address from a Claude Code hook context.
 *
 * Priority (highest first):
 *   1. CONCORDIA_SESSION_ID env — Lictor が wrap 時にだけ export する明示的な ID で、
 *      「この session は Concordia/Lictor が管轄している」 と宣言する強い signal.
 *   2. ctx.session_id (stdin) — Claude Code が hook context に詰めてくる ID.
 *      非 Lictor 環境では session-start hook がこの ID で Concordia へ登録する.
 *   3. CLAUDE_SESSION_ID env — fallback for hook implementations that don't pass stdin.
 *
 * NB: Lictor 配下では ctx.session_id / CLAUDE_SESSION_ID は Claude Code 内部 UUID
 * (Concordia 未登録) になるため、 これらを CONCORDIA_SESSION_ID より優先すると
 * isSessionActive が false 判定 → prompt/edit hook が全 no-op で抜ける.
 * 過去にこの順序で全 Lictor session が hook 沈黙していた regression があるので
 * 順序を変える際は tests/concordia-hook-session-id.test.mjs を必ず通すこと.
 */
export function resolveSessionId(ctx, env) {
  return env?.CONCORDIA_SESSION_ID ?? ctx?.session_id ?? env?.CLAUDE_SESSION_ID ?? null;
}

/**
 * Extract the user prompt text from a UserPromptSubmit hook payload.
 *
 * Provider 差:
 *  - Claude Code: `ctx.user_prompt`
 *  - Codex CLI:   `ctx.prompt`
 *
 * 両方未設定なら空文字を返す (POST 側で length=0 が記録される).
 */
export function resolvePromptText(ctx) {
  if (typeof ctx?.user_prompt === "string") return ctx.user_prompt;
  if (typeof ctx?.prompt === "string") return ctx.prompt;
  return "";
}

/**
 * Extract a human-readable "target" from a PostToolUse hook payload's
 * tool_input. Provider × tool 差:
 *  - Claude Code Edit/Write/MultiEdit: `tool_input.file_path` / `tool_input.path`
 *  - Codex CLI Bash:                   `tool_input.command`
 *  - Codex CLI apply_patch:            内部表現 (file_path や複合のはず、 落ちたら null)
 */
export function resolveEditTarget(ctx) {
  const ti = ctx?.tool_input;
  if (!ti || typeof ti !== "object") return null;
  return ti.file_path ?? ti.path ?? ti.command ?? null;
}
