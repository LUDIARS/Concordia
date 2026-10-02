/**
 * 重複した相談の近道 (spec/feature/tech-consultation.md §6、 2026-10-02 neco 指示)。
 *
 * 「相談セッションの内容は重複があればセッションや Tabula を案内し、 その内容のキャッシュされた回答を返却する」
 * 「重複の場合もセッションは起動して回答をショートカットするだけ」。
 *
 * セッションは必ず起動する。 ここは公開済みの相談 (Tabula へ出した Q&A) から似たものを文字の 2 文字組の
 * 一致度で選び、 初回指示に添える案内文を作るだけ。 重複かどうかの最終判断はセッション (モデル) に任せ、
 * 同じなら公開済みの回答を案内して差分だけ答えさせる。 非公開の相談の回答は他の人に返さないため、
 * 候補は公開済みのものに限る。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

export interface PublishedConsultation {
  title: string;
  summary: string;
  published_text: string | null;
  tabula_url: string | null;
}

export interface DuplicateCandidate {
  consultation: PublishedConsultation;
  score: number;
}

/** 候補に残す一致度の下限 (Dice 係数)。 低めにして、 判断はモデルに任せる。 */
export const DUPLICATE_MIN_SCORE = 0.3;
/** 案内する候補の上限。 */
export const DUPLICATE_MAX_CANDIDATES = 3;
/** 案内文に載せる公開回答の長さの上限 (文字)。 */
const ANSWER_EXCERPT_CHARS = 1500;

function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) grams.add(normalized.slice(i, i + 2));
  return grams;
}

/** 2 つの文の一致度 (文字の 2 文字組の Dice 係数、 0〜1)。 */
export function consultationSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** 新しい相談に似た公開済みの相談を、 一致度の高い順に選ぶ。 */
export function findDuplicateCandidates(
  query: string,
  published: readonly PublishedConsultation[],
  options: { minScore?: number; max?: number } = {},
): DuplicateCandidate[] {
  if (!query.trim()) return [];
  const minScore = options.minScore ?? DUPLICATE_MIN_SCORE;
  return published
    .map((consultation) => ({
      consultation,
      score: consultationSimilarity(query, `${consultation.title}\n${consultation.summary}`),
    }))
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.max ?? DUPLICATE_MAX_CANDIDATES);
}

/** 初回指示に添える案内文。 候補が無ければ null。 */
export function duplicateShortcutBlock(candidates: readonly DuplicateCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const lines = [
    "## 過去の公開回答 (重複の近道)",
    "この相談は、公開済みの相談と内容が重なっている可能性があります。まず下の候補と比べてください。",
    "- 同じ内容なら、公開済みの回答を要約して返し、記事のリンクを案内してください。足りない点だけを追加で答えてください。",
    "- 違う内容なら、候補には触れずに普段どおり答えてください。",
  ];
  candidates.forEach(({ consultation }, index) => {
    lines.push("", `### 候補 ${index + 1}: ${consultation.title}`);
    if (consultation.tabula_url) lines.push(`記事: ${consultation.tabula_url}`);
    lines.push(`要約: ${consultation.summary}`);
    const answer = consultation.published_text?.trim();
    if (answer) {
      const excerpt = answer.length > ANSWER_EXCERPT_CHARS ? `${answer.slice(0, ANSWER_EXCERPT_CHARS)}…` : answer;
      lines.push("公開済みの回答:", excerpt);
    }
  });
  return lines.join("\n");
}
