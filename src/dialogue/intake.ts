/**
 * 技術相談の事前ヒアリング (spec/feature/tech-consultation.md §3) — 純関数。
 *
 * 回答を始める前に 4 項目 (知りたいこと・技術レベル・役職・目的) を揃える。
 * 投稿本文の「ラベル: 値」行から読み、 無い項目は依頼者メモの既定値で埋め、
 * それでも欠けた項目だけを聞き返す。 聞き返しへの返信は本文へ
 * `CONSULT_INTAKE_REPLY_MARKER` 付きで追記される (forum-spawn-intake の supplement)。
 * 追記が 1 つでもあれば「目的は 1 度問うた」とみなし、 目的だけのために再度は聞かない
 * (「可能な限り目的を問う」— 知ること自体が目的の問いもある)。
 *
 * @implements SPEC-CONSULT-INTAKE
 */

export const CONSULT_INTAKE_FIELDS = ["topic", "skill_level", "role_title", "purpose"] as const;
export type ConsultIntakeField = typeof CONSULT_INTAKE_FIELDS[number];

export type ConsultIntake = Record<ConsultIntakeField, string>;

/** 必須項目。 目的は任意 (ただし必ず 1 度は問う)。 */
export const REQUIRED_CONSULT_INTAKE_FIELDS: readonly ConsultIntakeField[] = ["topic", "skill_level", "role_title"];

export const CONSULT_INTAKE_LABELS: Readonly<Record<ConsultIntakeField, string>> = {
  topic: "知りたいこと",
  skill_level: "技術レベル",
  role_title: "役職",
  purpose: "目的",
};

/** 聞き返しの入力例 (空欄のままだと何を書けばよいか迷うため)。 */
const CONSULT_INTAKE_HINTS: Readonly<Record<ConsultIntakeField, string>> = {
  topic: "例: DDD の集約をどう切るか",
  skill_level: "例: 初級 / 中級 / 上級、または経験年数",
  role_title: "例: エンジニア / デザイナー / プランナー / マネージャー",
  purpose: "例: 設計判断の参考にしたい。知ること自体が目的でも構いません",
};

/** ラベルの別名。 利用者が自然に書く言い方を拾う。 */
const LABEL_ALIASES: Readonly<Record<ConsultIntakeField, readonly string[]>> = {
  topic: ["知りたいこと", "知りたい事", "質問", "相談内容"],
  skill_level: ["技術レベル", "技術者レベル", "レベル"],
  role_title: ["役職", "役割", "職種"],
  purpose: ["目的", "ねらい", "狙い"],
};

/** 聞き返しへの返信を本文へ足すときの見出し。 */
export const CONSULT_INTAKE_REPLY_MARKER = "[相談の前提への回答]";

/** 1 項目の長さ上限 (起動ブロックを膨らませない)。 */
export const MAX_CONSULT_INTAKE_FIELD_CHARS = 1_000;

const EMPTY_INTAKE: ConsultIntake = { topic: "", skill_level: "", role_title: "", purpose: "" };

export interface ConsultIntakeDefaults {
  skill_level?: string;
  role_title?: string;
}

export interface ResolvedConsultIntake {
  intake: ConsultIntake;
  /** まだ聞き返すべき項目 (必須の欠け + 未だ問うていない目的)。 */
  missing: ConsultIntakeField[];
  /** 依頼者メモの既定値で埋めた項目 (聞き返しで「この値で答えます」と添える)。 */
  fromDefaults: ConsultIntakeField[];
  /** 聞き返しへの返信が本文に 1 回以上ある。 */
  asked: boolean;
}

/**
 * フォーラム投稿 (タイトル + 本文) から 4 項目を解決する。 知りたいことのラベルが無ければ
 * 投稿そのもの (タイトル → 本文の最初の段落) を知りたいこととみなす。
 */
export function resolveConsultIntake(input: {
  title: string;
  body: string;
  defaults?: ConsultIntakeDefaults | null;
}): ResolvedConsultIntake {
  const [original, ...replies] = input.body.split(CONSULT_INTAKE_REPLY_MARKER);
  const intake = { ...EMPTY_INTAKE, ...readLabeledFields(original ?? "") };
  if (!intake.topic) intake.topic = clip(input.title.trim() || firstParagraph(stripLabeledLines(original ?? "")));

  // 既定値は返信より先に埋める。 聞き返しは既定値で埋まらなかった項目だけを問うので、
  // ラベル無しの返信はその項目への答えとして読む必要がある。
  const defaulted = new Map<ConsultIntakeField, string>();
  for (const field of ["skill_level", "role_title"] as const) {
    const fallback = input.defaults?.[field]?.trim();
    if (!intake[field] && fallback) {
      intake[field] = clip(fallback);
      defaulted.set(field, intake[field]);
    }
  }
  for (const reply of replies) applyReply(intake, reply);
  // 返信で直した項目は「既定値で答える」確認の対象から外す。
  const fromDefaults = [...defaulted].filter(([field, value]) => intake[field] === value).map(([field]) => field);
  const asked = replies.length > 0;
  const missing = REQUIRED_CONSULT_INTAKE_FIELDS.filter((field) => !intake[field]);
  if (!intake.purpose && !asked) missing.push("purpose");
  return { intake, missing, fromDefaults, asked };
}

/** モーダル等で直接受け取った値を正規化する (空白を詰め、 長さを切る)。 */
export function normalizeConsultIntake(input: Partial<Record<ConsultIntakeField, unknown>>): ConsultIntake {
  const intake = { ...EMPTY_INTAKE };
  for (const field of CONSULT_INTAKE_FIELDS) {
    const value = input[field];
    if (typeof value === "string") intake[field] = clip(value.trim());
  }
  return intake;
}

export function isConsultIntakeComplete(intake: ConsultIntake): boolean {
  return REQUIRED_CONSULT_INTAKE_FIELDS.every((field) => intake[field].trim().length > 0);
}

/** 聞き返しの本文。 欠けた項目を 1 回にまとめ、 既定値で埋めた項目は確認として添える。 */
export function buildConsultIntakeQuestion(resolved: Pick<ResolvedConsultIntake, "intake" | "missing" | "fromDefaults">): string {
  const lines = [
    "回答の前提を揃えるため、次をこのスレッドに返信してください (「項目: 内容」の形で書けます)。",
    ...resolved.missing.map((field) => `${CONSULT_INTAKE_LABELS[field]}: (${CONSULT_INTAKE_HINTS[field]})`),
  ];
  if (resolved.fromDefaults.length > 0) {
    const known = resolved.fromDefaults.map((field) => `${CONSULT_INTAKE_LABELS[field]}「${resolved.intake[field]}」`);
    lines.push("", `${known.join("・")} として回答します。違えば同じ返信で直してください。`);
  }
  return lines.join("\n");
}

/** 聞き返しへの返信を本文へ足す形 (supplement の 1 要素)。 */
export function consultIntakeReplyBlock(reply: string): string {
  return `${CONSULT_INTAKE_REPLY_MARKER}\n${reply.trim()}`;
}

/**
 * 返信 1 通を反映する。 ラベル付きの行はその項目へ、 ラベルの無い行は「まだ空の項目」へ
 * 技術レベル → 役職 → 目的 の順に 1 行ずつ割り当てる (1 項目だけ欠けていれば返信全体をその項目に)。
 */
function applyReply(intake: ConsultIntake, reply: string): void {
  const labeled = readLabeledFields(reply, true);
  for (const field of CONSULT_INTAKE_FIELDS) {
    if (labeled[field]) intake[field] = labeled[field];
  }
  const rest = stripLabeledLines(reply, true).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rest.length === 0) return;
  const open = (["skill_level", "role_title", "purpose"] as const).filter((field) => !intake[field]);
  if (open.length === 0) return;
  if (open.length === 1) {
    intake[open[0]] = clip(rest.join(" "));
    return;
  }
  const parts = rest.length >= open.length ? rest : rest.flatMap((line) => line.split(/[、,，／/]/).map((part) => part.trim()).filter(Boolean));
  open.forEach((field, index) => {
    if (parts[index]) intake[field] = clip(parts[index]);
  });
}

function readLabeledFields(text: string, particle = false): Partial<ConsultIntake> {
  const found: Partial<ConsultIntake> = {};
  for (const line of text.split(/\r?\n/)) {
    for (const match of matchLabels(line, particle)) {
      if (match.value) found[match.field] = clip(match.value);
    }
  }
  return found;
}

function stripLabeledLines(text: string, particle = false): string {
  return text.split(/\r?\n/).filter((line) => matchLabels(line, particle).length === 0).join("\n");
}

const ALIAS_TO_FIELD = new Map<string, ConsultIntakeField>(
  CONSULT_INTAKE_FIELDS.flatMap((field) => LABEL_ALIASES[field].map((alias) => [alias, field] as const)),
);
// 長い名前を先に試す (「技術レベル」を「レベル」より先に)。
const ALIAS_PATTERN = [...ALIAS_TO_FIELD.keys()].sort((a, b) => b.length - a.length)
  .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/**
 * 項目名の後ろに「:」「：」が続く形を項目の指定として読む。 聞き返しへの返信 (particle) では助詞の「は」も読む
 * (投稿の本文の「今のレベルは低い」のような文を項目と取り違えないよう、 本文では読まない)。 行頭か区切り (空白・読点) の直後だけを見る。
 * 2026-10-03: 「技術レベルは初級 役職はデザイナー」の返信が読めず、 役職がプロフィールのエンジニアのまま起動した。
 */
const LABEL_PATTERN = new RegExp(`(?:^|[\\s\\u3000、,，])(${ALIAS_PATTERN})\\s*[:：]`, "g");
const LABEL_OR_PARTICLE_PATTERN = new RegExp(`(?:^|[\\s\\u3000、,，])(${ALIAS_PATTERN})\\s*(?:[:：]|は)`, "g");

/** 1 行の中の項目の指定をすべて読む (「役職: …」「技術レベルは初級 役職はデザイナー」のように 1 行に複数あってもよい)。 */
function matchLabels(line: string, particle = false): Array<{ field: ConsultIntakeField; value: string }> {
  const trimmed = line.trim().replace(/^[-*・]\s*/, "");
  const hits = [...trimmed.matchAll(particle ? LABEL_OR_PARTICLE_PATTERN : LABEL_PATTERN)];
  return hits.map((hit, index) => {
    const start = (hit.index ?? 0) + hit[0].length;
    const end = index + 1 < hits.length ? hits[index + 1]!.index ?? trimmed.length : trimmed.length;
    // 聞き返し文の「(例: …)」をそのまま返されたときは空とみなす。
    const value = trimmed.slice(start, end).trim().replace(/[、,，。]+$/, "").replace(/^\((例|例:)[^)]*\)$/, "").trim();
    return { field: ALIAS_TO_FIELD.get(hit[1]!)!, value };
  });
}

function firstParagraph(text: string): string {
  return text.trim().split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
}

function clip(value: string): string {
  return value.length > MAX_CONSULT_INTAKE_FIELD_CHARS ? value.slice(0, MAX_CONSULT_INTAKE_FIELD_CHARS) : value;
}
