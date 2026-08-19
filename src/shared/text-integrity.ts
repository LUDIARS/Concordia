/**
 * API 境界に届いたテキストが、途中で文字コードを壊されていないかの検査。
 *
 * Windows / Git Bash から native な `curl.exe` へ非 ASCII を **argv で**渡すと、
 * MSYS の argv 変換でバイトが落ち、日本語が U+FFFD (REPLACEMENT CHARACTER) に
 * 潰れた状態でサーバへ届く。壊れているのは送信側であって受信側ではないため、
 * Concordia がそのまま保存すると **復元不能な文字列が正本に残る**。
 *
 * この種の破損は気付かないまま蓄積しやすいため、「黙って保存」ではなく入口で
 * fail-fast する (RULE_CODE §5 I/O 境界の契約 / §9)。
 *
 * U+FFFD は「デコードに失敗した」ことを示す記号であり、正常な入力が意図して含める
 * 文字ではない。したがって混入は送信経路の不具合とみなしてよい。
 *
 * @implements spec/feature/testing-traffic.md — note の文字コード検証 (`SPEC-TESTING-CLAIM-NOTE-ENCODING`)
 */

/** Unicode REPLACEMENT CHARACTER。デコード失敗の痕跡。 */
export const REPLACEMENT_CHAR = "\uFFFD";

/**
 * 文字列に含まれる U+FFFD の個数。
 * @implements spec/feature/testing-traffic.md — note の文字コード検証 (`SPEC-TESTING-CLAIM-NOTE-ENCODING`)
 */
export function countReplacementChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === REPLACEMENT_CHAR) count += 1;
  }
  return count;
}

/**
 * U+FFFD を 1 つでも含むか (= 送信経路で壊れた疑いがあるか)。
 * @implements spec/feature/testing-traffic.md — note の文字コード検証 (`SPEC-TESTING-CLAIM-NOTE-ENCODING`)
 */
export function hasReplacementChars(text: string): boolean {
  return text.includes(REPLACEMENT_CHAR);
}

/**
 * 拒否理由の文言。直し方まで書く — 呼び出し元はたいてい CLI/エージェントで、
 * 「なぜ弾かれたか」より「どう送り直すか」が分からないと同じ失敗を繰り返す。
 *
 * @param field 壊れていた項目名 (例 "note")
 * @implements spec/feature/testing-traffic.md — note の文字コード検証 (`SPEC-TESTING-CLAIM-NOTE-ENCODING`)
 */
export function describeMojibakeRejection(field: string, text: string): string {
  const count = countReplacementChars(text);
  return [
    `${field} に文字化け (U+FFFD) が ${count} 文字含まれています。`,
    "送信経路で非 ASCII のバイトが失われているため、この内容は復元できません。",
    "シェルの引数へ日本語を直接埋め込まず (curl -d '...' は argv 変換で壊れます)、",
    "UTF-8 のファイルに書いてから `curl --data-binary @file.json` で送り直してください。",
  ].join("");
}
