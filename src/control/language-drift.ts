/**
 * assistant の発言が英語に流れたか (日本語で話すべきセッションで英語だけになったか) を判定する純関数。
 *
 * - コード片・インラインコード・URL・パスは英字が多くても文章ではないので数えない。
 * - 日本語の文には助詞・活用語尾のひらがなが必ず入る。英文の中に引用された部署名や
 *   コマンド名 (漢字・カタカナ) では増えないので、ひらがなの数を英単語の数と比べる。
 * - 短い発言 (「OK」「Done.」程度) は言語を決めつけない。
 *
 * spec/feature/session-language-guard.md §2 (CC-LANG-INV-01)。
 *
 * @implements SPEC-LANG-DETECT
 */

/** これ未満の英単語数は判定しない (短い発言を英語扱いしない)。 */
export const MIN_ENGLISH_WORDS = 12;
/** 英単語 1 語あたりのひらがながこれ未満なら英語の文とみなす。 */
export const MAX_HIRAGANA_PER_WORD = 0.25;

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
// URL とパスは ASCII の連なりだけを落とす。日本語は空白を挟まずに続くので、\S で取ると
// 隣の日本語の文まで消えてひらがなが減り、日本語の発言を英語と誤判定する。
const URL = /https?:\/\/[!-~]+/g;
/** `/` か `\` を含む ASCII の語 (パス・API ルート・ブランチ名) は文章の語ではない。 */
const PATH_LIKE = /[!-~]*[\\/][!-~]*/g;
const ENGLISH_WORD = /[A-Za-z]{2,}(?:['’][A-Za-z]+)?/g;
const HIRAGANA = /[ぁ-ゟ]/g;

export interface LanguageDriftVerdict {
  english: boolean;
  englishWords: number;
  hiragana: number;
}

/** 文章として読む部分だけを残す (コード・URL・パスを落とす)。 */
export function proseOf(text: string): string {
  return text
    .replace(FENCED_CODE, " ")
    .replace(INLINE_CODE, " ")
    .replace(URL, " ")
    .replace(PATH_LIKE, " ");
}

export function judgeLanguageDrift(text: string): LanguageDriftVerdict {
  const prose = proseOf(text);
  const englishWords = prose.match(ENGLISH_WORD)?.length ?? 0;
  const hiragana = prose.match(HIRAGANA)?.length ?? 0;
  const english = englishWords >= MIN_ENGLISH_WORDS && hiragana < englishWords * MAX_HIRAGANA_PER_WORD;
  return { english, englishWords, hiragana };
}

/** 日本語の文として読めるか (英語化が解けたかの判定に使う)。 */
export function isJapaneseProse(text: string): boolean {
  const { englishWords, hiragana } = judgeLanguageDrift(text);
  return hiragana > 0 && hiragana >= englishWords * MAX_HIRAGANA_PER_WORD;
}
