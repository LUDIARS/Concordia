// Discord 向け text 整形ユーティリティ. spec/discord-ui.md
//
// 純関数のみ — discord.js には依存しない (テスト容易).

/** Discord の content 上限 (2000 文字). 安全マージンで 1900 にしておく. */
export const DISCORD_MAX_CONTENT = 1900;

/** session_id → channel 名 slug 化 ("s-bdea-fukawatari"). */
export function sessionChannelSlug(sessionId: string, roleLabel: string | null): string {
  // 先頭 4 文字 (lictor-<uuid> なら uuid 先頭 4)
  const idPart = sessionId.replace(/^lictor-/, "").slice(0, 4) || "anon";
  const rolePart = roleSlug(roleLabel ?? "anon");
  return `s-${idPart}-${rolePart}`.slice(0, 90); // Discord channel 名は 100 文字制限
}

/**
 * role_label を Discord channel name に使える slug にする.
 *  - 英数字・かな漢字・- 以外は -
 *  - 連続 - は 1 つ
 *  - 先頭末尾の - は除去
 *  - 大文字は小文字 (英字のみ)
 *  - 空なら 'role'
 */
export function roleSlug(role: string): string {
  // Discord は基本的に lowercase ASCII + 一部記号を要求する (名前自体はマルチバイト OK だが
  // タブで見づらいので Latin はガッツリ slug 化、 日本語はそのまま通す)
  const trimmed = role
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return trimmed || "role";
}

/** prefix emoji を変える (channel rename 用). */
export function applyStatusEmoji(
  current: string,
  status: "active" | "lost" | "ended",
): string {
  const stripped = current.replace(/^[🟢🟡🟥⚪]\s*-?/u, "");
  const emoji = status === "active" ? "🟢" : status === "lost" ? "🟥" : "⚪";
  return `${emoji}-${stripped.replace(/^-/, "")}`;
}

/**
 * 長文を Discord 向け chunk に分割する.
 *  - DISCORD_MAX_CONTENT を超えたら段落単位 → 行単位で割る
 *  - 1 行が長すぎる場合は強制的に切る
 *  - 空 chunk は返さない
 */
export function chunkForDiscord(text: string, max = DISCORD_MAX_CONTENT): string[] {
  if (!text) return [];
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      out.push(remaining);
      break;
    }
    // 段落 → 行 → 強制切断 の順
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return out;
}

/** persona の display name + role を 1 行にまとめる (webhook username 用). */
export function formatAuthorName(displayName: string | null, role: string | null): string {
  const name = displayName?.trim();
  const r = role?.trim();
  if (name && r && name !== r) return `${name} (${r})`;
  return name ?? r ?? "Concordia";
}
