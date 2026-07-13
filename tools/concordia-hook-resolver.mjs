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
 * Active 判定で候補から正しい session ID を選ぶ (混線対策).
 *
 * 問題: CONCORDIA_SESSION_ID を shell profile 等でグローバルに export していると、
 * 同ウインドウ内の全タブが同じ env を継承し、 全タブが同一 session の
 * pending-tasks を pull → 「別セッション宛の通知が全タブに飛ぶ」 混線が起きる。
 *
 * 対策: 候補を **ctx.session_id (hook 1 回ごとに固有) を最優先** に並べ、
 * Concordia が active と確認できた最初の候補を採用する。
 *   - 非 Lictor (plain claude/codex): ctx.session_id が登録済 active → 共有 env を
 *     無視して自分の session を正しく引く。
 *   - Lictor 配下: ctx.session_id は未登録の Claude 内部 UUID なので active 判定が
 *     false → CONCORDIA_SESSION_ID (lictor-xxx, active) にフォールバック。
 *     これにより PR #35 の「Lictor で hook が全 no-op」 regression を再発させない。
 *
 * `isActiveFn(id) -> Promise<boolean>` は呼び出し側が注入する (テスト容易性のため)。
 * どの候補も active でなければ null を返す → 呼び出し側で resolveSessionId の
 * 純粋フォールバックに委ねる。
 */
export async function pickActiveSessionId(ctx, env, isActiveFn) {
  const seen = new Set();
  const candidates = [];
  for (const c of [ctx?.session_id, env?.CONCORDIA_SESSION_ID, env?.CLAUDE_SESSION_ID]) {
    if (typeof c === "string" && c.length > 0 && !seen.has(c)) {
      seen.add(c);
      candidates.push(c);
    }
  }
  for (const id of candidates) {
    if (await isActiveFn(id)) return id;
  }
  return null;
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

/** git-dir と common-dir が異なる cwd は linked worktree。git 失敗時は undefined。 */
export function resolveIsWorktree(cwd, execGit) {
  if (!cwd || typeof execGit !== "function") return undefined;
  try {
    const gitDir = String(execGit("git rev-parse --git-dir", cwd)).trim().replace(/\\/g, "/");
    const commonDir = String(execGit("git rev-parse --git-common-dir", cwd)).trim().replace(/\\/g, "/");
    if (!gitDir || !commonDir) return undefined;
    return gitDir !== commonDir;
  } catch {
    return undefined;
  }
}
