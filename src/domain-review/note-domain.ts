/**
 * src/domain-review/note-domain.ts — ドメインへの指摘 (domain-note) がどのドメインの話かを決める規則。
 *
 * 返信本文の先頭が既知ドメインの名前か id で、 直後が `:` / `：` なら そのドメイン
 * (例「combat: ダメージ計算は武器側」)。 決まらなければ選択ダイアログに出す選択肢を作る。
 *
 * **推測しない。** 複数のドメインに一致する先頭指定は未決として扱い、 人に選ばせる。
 * Anatomia も知らない domainId は rejected にするので、 ここで寄せても意味が無い。
 *
 * SRP: 照合と選択肢の組み立てだけ (純関数)。 送信と台帳は note-delivery.ts、
 * Discord の部品は src/discord/domain-review-note-choice.ts。
 *
 * @implements spec/feature/domain-review-discord.md §4.2
 */

/** 照合に使うドメイン 1 件。 Anatomia の `GET /api/projects/:id/domains` は id = 名前。 */
export interface NoteDomainCandidate {
  id: string;
  name: string;
}

/** 「どのドメインでもない (プロジェクト全体)」を表す選択値。 ドメイン id と衝突しない。 */
export const NOTE_DOMAIN_PROJECT_WIDE = "*";

/**
 * Discord の StringSelect は 25 件まで。 1 枠は「プロジェクト全体」に使うので、
 * ドメインは先頭 24 件まで。 超えた分は選択肢に出さず、 先頭指定での返信を案内する。
 */
export const MAX_NOTE_DOMAIN_CHOICES = 24;

/** StringSelect の value の上限 (Discord)。 これを超える id は選択肢に出せない。 */
const MAX_CHOICE_VALUE_LENGTH = 100;

export type NoteDomainResolution =
  | { kind: "domain"; domainId: string; note: string }
  | { kind: "unresolved" };

/**
 * 本文の先頭指定からドメインを決める。 大小・前後空白・全角コロンを吸収する。
 * 指定先の候補が 0 件または 2 件以上、 区切りの後ろが空なら unresolved。
 */
export function resolveNoteDomain(
  text: string,
  domains: readonly NoteDomainCandidate[],
): NoteDomainResolution {
  const match = /^\s*([^:：\n]+?)\s*[:：]\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: "unresolved" };
  const head = normalizeKey(match[1] ?? "");
  const note = (match[2] ?? "").trim();
  if (!head || !note) return { kind: "unresolved" };
  const hits = new Set<string>();
  for (const domain of domains) {
    if (normalizeKey(domain.id) === head || normalizeKey(domain.name) === head) hits.add(domain.id);
  }
  if (hits.size !== 1) return { kind: "unresolved" };
  const [domainId] = [...hits];
  return { kind: "domain", domainId: domainId!, note };
}

export interface NoteDomainChoice {
  /** ドメイン id、 または NOTE_DOMAIN_PROJECT_WIDE。 */
  value: string;
  label: string;
}

export interface NoteDomainChoices {
  choices: NoteDomainChoice[];
  /** 選択肢に出せなかったドメインの数 (25 件上限・長すぎる id)。 0 なら全件出ている。 */
  omitted: number;
}

/**
 * 選択ダイアログの選択肢。 ドメインは名前順で先頭 24 件、 最後に「プロジェクト全体」。
 * id の重複は 1 件に畳む。
 */
export function buildNoteDomainChoices(domains: readonly NoteDomainCandidate[]): NoteDomainChoices {
  const unique = new Map<string, NoteDomainCandidate>();
  for (const domain of domains) {
    if (!domain.id || unique.has(domain.id)) continue;
    unique.set(domain.id, domain);
  }
  const selectable = [...unique.values()]
    .filter((domain) => domain.id.length <= MAX_CHOICE_VALUE_LENGTH && domain.id !== NOTE_DOMAIN_PROJECT_WIDE)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const shown = selectable.slice(0, MAX_NOTE_DOMAIN_CHOICES);
  return {
    choices: [
      ...shown.map((domain) => ({ value: domain.id, label: domain.name || domain.id })),
      { value: NOTE_DOMAIN_PROJECT_WIDE, label: "どのドメインでもない (プロジェクト全体)" },
    ],
    omitted: unique.size - shown.length,
  };
}

/**
 * 選択値をドメイン id に直す。 プロジェクト全体は null。
 * 空文字・上限超えは不正 (undefined) として扱い、 送信しない。
 */
export function parseNoteDomainChoice(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CHOICE_VALUE_LENGTH) return undefined;
  return trimmed === NOTE_DOMAIN_PROJECT_WIDE ? null : trimmed;
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}
