/**
 * Revisor reviewReport の記録内容 (content) を読み取る境界。
 *
 * Revisor は構造化データを JSON 文字列で保存し、秘匿値を含む行を `[redacted: 規則]` に
 * 置き換える。 利用者へは JSON を見せず、ここで値へ戻してから人間向けの文章に組み立てる。
 * 壊れた記録・未対応の形式は生の断片を出さず、表示できない旨を書く。 読めない内容を
 * 空や成功へ読み替えない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */

export type EntryContent =
  | { kind: "structured"; value: unknown }
  | { kind: "masked"; rules: string }
  | { kind: "text"; text: string }
  | { kind: "unreadable" };

export type Fields = Readonly<Record<string, unknown>>;

export const UNREADABLE_CONTENT_NOTICE = "この記録は形式が壊れているため、内容を表示できません。";
export const UNSUPPORTED_CONTENT_NOTICE = "この記録形式は Concordia が未対応のため、内容を表示できません。";

const WHOLE_MASK = /^\[redacted: ([^\]\n]*)\]$/;
const MASKED_LINE = /^\[redacted: [^\]\n]*\]$/gm;

export function readEntryContent(content: string): EntryContent {
  const trimmed = content.trim();
  const masked = WHOLE_MASK.exec(trimmed);
  if (masked) return { kind: "masked", rules: masked[1] ?? "" };
  if (trimmed === "null") return { kind: "structured", value: null };
  if (/^[[{]/.test(trimmed)) {
    try {
      return { kind: "structured", value: JSON.parse(trimmed) as unknown };
    } catch {
      // 構造化データの一部の行だけが伏せられた場合も含め、JSON の断片を文章として出さない。
      return trimmed.includes("[redacted:") ? { kind: "masked", rules: "" } : { kind: "unreadable" };
    }
  }
  return { kind: "text", text: humanizeMaskedLines(content) };
}

/** 文章の中で伏せられた行を、利用者が意味を読める一文に置き換える。 */
export function humanizeMaskedLines(text: string): string {
  return text.replace(MASKED_LINE, "（秘匿値を含む可能性がある行を Revisor がマスクしました）");
}

export function maskedContentNotice(rules: string): string {
  const detected = rules.trim() ? `（検出規則: ${rules.trim()}）` : "";
  return `秘匿値を含む可能性があるため、Revisor がこの記録の内容をマスクしました。${detected}`;
}

export function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

export function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringsOf(value: unknown): string[] {
  return listOf(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function hasField(fields: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

/** 見出し付きの段落。 Discord 本文と添付テキストのどちらでも見出しと読める記号にする。 */
export function section(title: string, lines: readonly string[]): string {
  return [`■ ${title}`, ...lines].join("\n");
}

/** `- 項目` の箇条書き。 空なら Revisor 画面と同じく「ありません」を明記する。 */
export function bulletLines(items: readonly string[], emptyMessage: string): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [emptyMessage];
}

/** 複数行の本文を Discord でも添付テキストでも本文と分かる引用にする。 */
export function quoteLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => `> ${line}`);
}
