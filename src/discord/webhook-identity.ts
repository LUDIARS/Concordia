const DISCORD_WEBHOOK_USERNAME_MAX = 80;
const TWEMOJI_BASE_URL =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";

export interface DiscordWebhookIdentityInput {
  model?: string | null;
  provider?: string | null;
  callName?: string | null;
  currentTask?: string | null;
  roleLabel?: string | null;
  configuredName?: string | null;
  fallbackName?: string | null;
  delegationEmoji?: string | null;
}

export interface DiscordWebhookIdentity {
  username: string;
  avatarURL?: string;
}

/** Delegation の実行情報から、Discord webhook ごとの表示 identity を組み立てる。 */
export function buildDiscordWebhookIdentity(
  input: DiscordWebhookIdentityInput,
): DiscordWebhookIdentity {
  const modelName = friendlyModelName(input.model, input.provider);
  const identityName = firstNormalized([
    input.callName,
    input.configuredName,
    input.currentTask,
    input.roleLabel,
    input.fallbackName,
  ]) ?? "Concordia";
  const separator = " · ";
  const identityLimit = Math.max(
    1,
    DISCORD_WEBHOOK_USERNAME_MAX - modelName.length - separator.length,
  );
  const username = `${modelName}${separator}${identityName.slice(0, identityLimit)}`.slice(
    0,
    DISCORD_WEBHOOK_USERNAME_MAX,
  );
  const avatarURL = delegationEmojiAvatarUrl(input.delegationEmoji);
  return { username, ...(avatarURL ? { avatarURL } : {}) };
}

/** Unicode emoji を pinned Twemoji PNG URL へ変換する。 */
export function delegationEmojiAvatarUrl(emoji: string | null | undefined): string | null {
  const normalized = emoji?.trim().replaceAll("\uFE0F", "") ?? "";
  if (!normalized || !hasEmojiCodePoint(normalized)) return null;
  if ([...normalized].some((char) => !isEmojiSequenceCodePoint(char))) return null;
  const codePoints = [...normalized].map((char) => char.codePointAt(0)!.toString(16));
  return codePoints.length > 0 ? `${TWEMOJI_BASE_URL}/${codePoints.join("-")}.png` : null;
}

export function friendlyModelName(
  model: string | null | undefined,
  provider?: string | null,
): string {
  const normalized = model?.trim().toLowerCase() ?? "";
  const exact = FRIENDLY_MODEL_NAMES[normalized];
  if (exact) return exact;
  if (normalized.startsWith("gpt-")) {
    return normalized
      .split("-")
      .map((part, index) => index === 0 ? "GPT" : titlePart(part))
      .join("-");
  }
  if (normalized.startsWith("claude-")) {
    return normalized
      .slice("claude-".length)
      .split("-")
      .map(titlePart)
      .join(" ");
  }
  if (model?.trim()) return normalizeWhitespace(model);
  if (provider?.toLowerCase().includes("codex")) return "Codex";
  if (provider?.toLowerCase().includes("claude")) return "Claude";
  return "Concordia";
}

const FRIENDLY_MODEL_NAMES: Readonly<Record<string, string>> = {
  "claude-fable-5": "Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
};

function firstNormalized(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value?.trim()) continue;
    return normalizeWhitespace(value);
  }
  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titlePart(value: string): string {
  return /^\d/.test(value) ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function hasEmojiCodePoint(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(value);
}

function isEmojiSequenceCodePoint(value: string): boolean {
  const codePoint = value.codePointAt(0)!;
  return (
    value === "\u200D"
    || value === "\u20E3"
    || (codePoint >= 0x1F3FB && codePoint <= 0x1F3FF)
    || /\p{Extended_Pictographic}/u.test(value)
    || /\p{Emoji_Presentation}/u.test(value)
  );
}
