/**
 * session-log 本文から「どのプロジェクトの作業か」を機械抽出する。
 *
 * 語彙は **project code registry が正本** (`project_codes` テーブル /
 * `GET /v1/project-codes`)。 以前はここに正式名の配列を直接持っていたが、
 *
 *   1. registry と二重管理になり、片方だけ増えて食い違う
 *   2. このリポジトリは public なので、取引先・未公開プロダクトの名前が
 *      ソースに載ってしまう
 *
 * の 2 つが問題だった (spec/plan/2026-09-04-externalize-partner-identifiers.md)。
 *
 * 照合するのは**正式名だけ**。 略称コード (2 文字) は英文中の "An" などに当たって
 * 誤検出するので採用しない。 session-log は見出し・本文とも正式名で書かれる慣習。
 */

/**
 * 語彙から常に外す名前。
 *
 * workspace の共通親パスに遍在して全 log にマッチしてしまうため、
 * タグとして意味を持たない。 registry に載っていることと、ここで語彙に採るべきかは
 * 別の話なので、registry 側ではなく抽出側の規則として持つ。
 */
const UBIQUITOUS_NAMES = new Set(["ars", "ludiars", "infra"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 照合順を決める。 長い名前を先に見ることで、`Actio` が
 * `Actio-PublicModules` の内側に当たって親子の二重タグになるのを防ぐ。
 */
export function orderProjectNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .filter((name) => !UBIQUITOUS_NAMES.has(name.toLowerCase()))
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * テキスト中に登場するプロジェクト正式名を抽出する。
 *
 * 判定: 名前が 1 回でも出れば「そのログの対象プロジェクト」とみなす。 用途は
 * 「過去作業を引き継ぐために該当プロジェクトのログを見つける」ことなので、
 * 取りこぼし (recall) を多少の過剰タグ (precision) より優先する。
 *
 * 語境界は ASCII 単語文字 / ハイフンの不在で判定する (`\w` は ASCII なので、
 * 日本語が直後に続く "Anatomia残タスク" でもマッチする)。 これにより "Actio" は
 * "Actio-PublicModules" の内側にはマッチしない (直後が `-`)。
 *
 * **語彙が空なら何もタグ付けしない。** registry を引けなかったときに組み込みの
 * 一覧へ落ちると、外に出した名前がソースへ戻ってしまう。 タグが付かないことは
 * 一覧で気づけるが、こっそり復活した名前には気づけない。
 */
export function extractProjects(text: string, names: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const name of orderProjectNames(names)) {
    const re = new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`);
    if (re.test(text)) found.push(name);
  }
  return found;
}
