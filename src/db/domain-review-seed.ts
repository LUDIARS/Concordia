/**
 * src/db/domain-review-seed.ts — `project_codes.domain_review` の初期値判定。
 *
 * 設計書 §8.3 (DDD 適用範囲) の写し:
 *  - 適用 (= 1): LUDIARS のプロダクト (ゲーム / コアエンジン / ツール / Hub 群) と
 *    MELPOT の MakaiNui / MakaiNuiPictor。
 *  - 非適用 (= 0): Castra (= ワークスペース root の Ars。 設定・スキル置き場)、
 *    メタ / インフラ枠、 書類系、 外部リポ。
 *
 * **列を追加した回だけ**この判定を流す (migration)。 以後は人が /projects で
 * 切り替えた値が正本で、 再実行して上書きしない。
 *
 * SRP: 判定だけ。 SQL も I/O も持たない。
 */

/** DDD を適用する org。 外部リポ (これ以外の owner) は既定 OFF。 */
const DDD_OWNERS = new Set(["ludiars", "melpot"]);

/**
 * org 配下でも適用しないリポ。 PROJECT-CODES.md の「メタ / インフラ」枠と
 * ワークスペース root (Castra = Ars) — いずれもプロダクトではなく、
 * コアドメインをレビューする対象が無い。
 */
const NON_PRODUCT_PROJECTS = new Set([
  "ars",
  "castra",
  "ludiars",
  "infra",
  "aiformat",
  "all-in-onetest",
]);

export interface DomainReviewSeedInput {
  /** project_codes.project (= リポジトリ名)。 */
  project: string;
  /** project_codes.repo_origin。 未設定の登録は owner が分からない。 */
  repoOrigin: string | null;
}

/**
 * その登録を既定でドメインレビュー対象にするか。
 *
 * repo_origin が無い登録は owner を確かめられないので OFF に倒す —
 * 「分からないから念のため ON」にすると、 書類系リポの Discord チャンネルに
 * 意味の無いドメイン投稿が流れ続けることになる。
 */
export function seedDomainReview(input: DomainReviewSeedInput): boolean {
  const owner = ownerFromOrigin(input.repoOrigin);
  if (!owner || !DDD_OWNERS.has(owner)) return false;
  return !NON_PRODUCT_PROJECTS.has(input.project.trim().toLowerCase());
}

/**
 * `https://github.com/OWNER/NAME(.git)` / `git@github.com:OWNER/NAME.git` /
 * `OWNER/NAME` から owner を小文字で取り出す。 取れなければ null。
 */
function ownerFromOrigin(origin: string | null): string | null {
  const value = origin?.trim();
  if (!value) return null;
  const match = /^(?:(?:https?:\/\/github\.com\/|git@github\.com:))?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/i
    .exec(value);
  return match ? match[1]!.toLowerCase() : null;
}
