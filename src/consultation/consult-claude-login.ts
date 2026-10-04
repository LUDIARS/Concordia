/**
 * 相談専用の Claude 設定フォルダのログイン状態の判定 (spec/feature/tech-consultation.md §6.3)。
 *
 * 2026-10-03、 相談専用の設定フォルダの `.credentials.json` は存在したが OAuth の更新に失敗しており (OAuth Error 400)、
 * 相談の claude が起動直後のログイン画面で止まった。 それまでの判定はファイルの有無だけだった。
 * ここではファイルの中身から、 起動しても確実に止まる状態 (更新用トークンが無い・期限切れ) を起動前に見分ける。
 * アクセストークンの期限切れは claude が更新するので止めない。 更新用トークンが無効にされた場合はファイルからは
 * 分からないので、 起動後の見張り (consult-startup-watch.ts) が拾う。
 *
 * 業務判断だけを持つ純関数。 トークンの値は読まず、 有無と期限だけを見る (ログにも出さない)。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

export type ConsultClaudeLoginState =
  | { ready: true }
  | { ready: false; reason: "missing" | "unreadable" | "no_refresh_token" | "refresh_expired" };

/** `.credentials.json` の本文 (無ければ null) からログイン状態を判定する。 nowMs は現在時刻 (ms)。 */
export function consultClaudeLoginState(credentialsJson: string | null, nowMs: number): ConsultClaudeLoginState {
  if (credentialsJson === null) return { ready: false, reason: "missing" };
  let oauth: unknown;
  try {
    oauth = (JSON.parse(credentialsJson) as { claudeAiOauth?: unknown })?.claudeAiOauth;
  } catch {
    return { ready: false, reason: "unreadable" };
  }
  if (!oauth || typeof oauth !== "object") return { ready: false, reason: "unreadable" };
  const { refreshToken, refreshTokenExpiresAt } = oauth as { refreshToken?: unknown; refreshTokenExpiresAt?: unknown };
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return { ready: false, reason: "no_refresh_token" };
  if (typeof refreshTokenExpiresAt === "number" && refreshTokenExpiresAt <= nowMs) return { ready: false, reason: "refresh_expired" };
  return { ready: true };
}

/** 人がログインし直すコマンド (運用者への案内に使う)。 */
export function consultClaudeReloginCommand(configDir: string): string {
  return `$env:CLAUDE_CONFIG_DIR = "${configDir}"; claude   # 起動後に /login`;
}
