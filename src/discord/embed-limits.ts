/**
 * src/discord/embed-limits.ts — Discord embed の上限に必ず収める。
 *
 * Discord は上限を 1 つでも超えると **メッセージ全体を 400 で拒否する**。
 * ドメイン情報の投稿はドメイン数も説明文の長さも Anatomia 次第で、 こちらから
 * 抑えられない。 だから「切り詰めて省略を明示する」を 1 箇所に閉じ、 描画側は
 * ここを通したものだけを送る。
 *
 * もう 1 つの役目は **メンションの無害化**。 embed に入る文字列 (ドメイン名・
 * 説明・plan の問い) は Anatomia と LLM 由来 = 信頼できない入力で、 そのまま
 * 出すと `@everyone` が実発火しうる。 送信時の `allowed_mentions` と二重で守る。
 *
 * SRP: 文字数と記法の始末だけ。 何を載せるかは domain-review-embeds.ts。
 *
 * @implements spec/feature/domain-review-discord.md §2.5
 */

/** Discord の実上限 (2026-09 時点)。 */
export const EMBED_LIMITS = {
  title: 256,
  description: 4_096,
  fieldName: 256,
  fieldValue: 1_024,
  footer: 2_048,
  fieldsPerEmbed: 25,
  embedsPerMessage: 10,
  /** 1 メッセージ内の全 embed 合計。 */
  totalCharacters: 6_000,
} as const;

export interface EmbedFieldSpec {
  name: string;
  value: string;
  inline?: boolean;
}

/** discord.js に渡す前の素の embed。 テストから上限を検査できるよう plain object。 */
export interface EmbedSpec {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedFieldSpec[];
  footer?: { text: string };
}

/**
 * メンションを無害化する。 削らずに壊す — 「誰宛てだったか」は読めたほうがよい。
 * `@everyone` / `@here` は `@` の直後、 `<@…>` は `<` の直後に zero-width space。
 */
export function sanitizeMentions(value: string): string {
  return value
    .replace(/@(everyone|here)\b/g, "@​$1")
    .replace(/<@([!&]?\d+)>/g, "<​@$1>");
}

/** 上限に収め、 切り詰めたら省略を明示する。 黙って消さない。 */
export function clampText(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const suffix = `…(以下省略: ${value.length - max} 文字)`;
  if (suffix.length >= max) return value.slice(0, max);
  return `${value.slice(0, max - suffix.length).trimEnd()}${suffix}`;
}

/**
 * 行のリストを 1 field value に詰める。 入り切らない分は末尾に件数で示す。
 * 1 件も入らない場合でも「N 件」だけは残す (0 件と区別できるように)。
 */
export function clampLines(lines: readonly string[], max: number = EMBED_LIMITS.fieldValue): string {
  if (lines.length === 0) return "(なし)";
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const addition = (kept.length === 0 ? 0 : 1) + line.length;
    // 省略行ぶんの余白を残しておく。 最後の 1 行で上限を跨ぐと省略を書けなくなる。
    if (length + addition > max - 32 && kept.length > 0) break;
    kept.push(line);
    length += addition;
  }
  const hidden = lines.length - kept.length;
  if (hidden === 0) return clampText(kept.join("\n"), max);
  if (kept.length === 0) return clampText(`…以下省略 (${hidden} 件)`, max);
  return clampText(`${kept.join("\n")}\n…以下省略 (${hidden} 件)`, max);
}

/**
 * embed 一式を Discord の上限に収める。
 *
 * 順に (1) 各文字列を上限へ、 (2) field を 25 個へ、 (3) embed を 10 枚へ、
 * (4) 合計 6000 文字へ。 (2)(3)(4) の切り落としは必ず件数で明示する。
 * **ここを通った embed は Discord に 400 で拒否されない**、が唯一の約束。
 */
export function fitEmbeds(embeds: readonly EmbedSpec[]): EmbedSpec[] {
  const normalized = embeds.map(normalizeEmbed);
  const limited = normalized.slice(0, EMBED_LIMITS.embedsPerMessage);
  const droppedEmbeds = normalized.length - limited.length;
  if (droppedEmbeds > 0 && limited.length > 0) {
    const last = limited[limited.length - 1]!;
    last.footer = {
      text: clampText(
        `${last.footer?.text ? `${last.footer.text} / ` : ""}以下省略 (embed ${droppedEmbeds} 枚)`,
        EMBED_LIMITS.footer,
      ),
    };
  }

  // 合計 6000 は「全 embed の title + description + field name/value + footer」の和。
  // 後ろの embed から落として収める (先頭ほど要約に近い並びにしてある)。
  while (limited.length > 1 && totalCharacters(limited) > EMBED_LIMITS.totalCharacters) {
    limited.pop();
    const last = limited[limited.length - 1]!;
    last.footer = { text: clampText("…以下省略 (文字数上限)", EMBED_LIMITS.footer) };
  }
  // 1 枚に減らしても超えるなら、 その 1 枚の field を後ろから落とす。
  const only = limited[0];
  if (only) {
    while (totalCharacters(limited) > EMBED_LIMITS.totalCharacters && (only.fields?.length ?? 0) > 0) {
      only.fields!.pop();
      only.footer = { text: "…以下省略 (文字数上限)" };
    }
    if (totalCharacters(limited) > EMBED_LIMITS.totalCharacters) {
      const overflow = totalCharacters(limited) - EMBED_LIMITS.totalCharacters;
      only.description = clampText(only.description ?? "", Math.max(0, (only.description?.length ?? 0) - overflow));
    }
  }
  return limited;
}

function normalizeEmbed(embed: EmbedSpec): EmbedSpec {
  const fields = (embed.fields ?? []).slice(0, EMBED_LIMITS.fieldsPerEmbed).map((field) => ({
    name: clampText(sanitizeMentions(field.name), EMBED_LIMITS.fieldName),
    value: clampText(sanitizeMentions(field.value), EMBED_LIMITS.fieldValue) || "(なし)",
    ...(field.inline === undefined ? {} : { inline: field.inline }),
  }));
  const droppedFields = (embed.fields?.length ?? 0) - fields.length;
  if (droppedFields > 0 && fields.length > 0) {
    fields[fields.length - 1] = {
      ...fields[fields.length - 1]!,
      value: clampText(
        `${fields[fields.length - 1]!.value}\n…以下省略 (${droppedFields} 項目)`,
        EMBED_LIMITS.fieldValue,
      ),
    };
  }
  return {
    ...(embed.title === undefined ? {} : { title: clampText(sanitizeMentions(embed.title), EMBED_LIMITS.title) }),
    ...(embed.description === undefined
      ? {}
      : { description: clampText(sanitizeMentions(embed.description), EMBED_LIMITS.description) }),
    ...(embed.color === undefined ? {} : { color: embed.color }),
    ...(embed.footer === undefined
      ? {}
      : { footer: { text: clampText(sanitizeMentions(embed.footer.text), EMBED_LIMITS.footer) } }),
    fields,
  };
}

/** Discord が 6000 と数える対象の合計。 */
export function totalCharacters(embeds: readonly EmbedSpec[]): number {
  let total = 0;
  for (const embed of embeds) {
    total += (embed.title ?? "").length;
    total += (embed.description ?? "").length;
    total += (embed.footer?.text ?? "").length;
    for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  }
  return total;
}
