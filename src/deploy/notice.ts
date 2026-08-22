/**
 * Revisor の lifecycle event `checkout_published` を、既存の Revisor → Cc 通知
 * (session.inject / chat 投稿) の本文から読み取る。
 *
 * Revisor は「登録 checkout を merge commit へ fast-forward した」ことを
 * `checkout_published`、見送りを `checkout_publish_skipped` として通知する
 * (Revisor `spec/feature/checkout-publication.md` §4)。 Cc は通知経路を増やさず、
 * 既に購読している通知本文からこのイベントだけを拾う。
 *
 * 通知本文は人間向けの日本語文で、Revisor 側の文面は変わりうる。 そのため
 * **イベント名 (`checkout_published`) を第一の手掛かり**にし、文面 (「本体 checkout を
 * … へ前進させました」) は補助の手掛かりとして扱う。 どちらも読めなければ null を
 * 返す — 曖昧なまま deploy を起動する方が危険なので、ここは fail-closed にする。
 *
 * @implements spec/feature/checkout-published-deploy.md §2 (`SPEC-CHECKOUT-PUBLISHED-NOTICE`)
 */

/** 通知から読み取れた checkout 前進 1 件。 */
export interface CheckoutPublishedNotice {
  /** `owner/repo` または `repo`。 サービス解決はローカルのディレクトリ名で行う。 */
  repository: string | null;
  /** 前進先の commit (先頭 7-40 文字の hex)。 読めなければ null。 */
  sha: string | null;
  /** local PR 番号。 読めなければ null。 */
  prNumber: number | null;
}

/** イベント名そのもの。 Revisor が本文へ機械可読な形で載せた場合に効く。 */
const EVENT_NAME = /checkout[_\s-]?published/i;
/** 見送り (deploy してはいけない)。 event 名でも文面でも拾う。 */
const SKIPPED_NAME = /checkout[_\s-]?publish[_\s-]?skipped/i;
/** 日本語文面 (Revisor spec §4 の成功文言)。 */
const JA_ADVANCED = /checkout\s*を.*前進させました/;
/** `owner/repo#123` / `repo#123`。 */
const LABEL = /([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)#(\d+)/;
/**
 * 単独の commit hash (先頭 12 文字の表示を含む)。
 *
 * PR 番号が 7 桁以上だと `#1234567` の数字列もこの形に当てはまる。 sha は重複抑止の
 * キーになるので、 PR 番号を sha と取り違えると「別の前進」と誤認して二重に再起動しうる。
 * そのため **label が消費した区間だけを除いた全文**から探す (下記 parse を参照)。
 * 「label より後ろだけ」にすると、 sha が label より前に出る文面
 * (`… を 1a2b3c4 へ前進させました (Concordia#364)`) で sha を取りこぼす。
 */
const SHA = /\b([0-9a-f]{7,40})\b/;

/**
 * 通知本文から checkout_published を読む。 該当しなければ null。
 *
 * @implements spec/feature/checkout-published-deploy.md §2 (`SPEC-CHECKOUT-PUBLISHED-NOTICE`) — 通知の受け口
 *
 * 見送り通知 (`checkout_publish_skipped`) は成功語 (`checkout_published`) を部分文字列
 * として含みうるため、**先に見送りを弾く**。
 */
export function parseCheckoutPublishedNotice(text: string): CheckoutPublishedNotice | null {
  if (!text) return null;
  if (SKIPPED_NAME.test(text)) return null;
  if (!EVENT_NAME.test(text) && !JA_ADVANCED.test(text)) return null;

  const label = LABEL.exec(text);
  // label (`repo#123`) が占める区間を空白で潰した全文から sha を探す。 PR 番号を sha と
  // 読まず、 かつ sha が label の前後どちらに出ても拾えるようにするため。
  const masked = label
    ? text.slice(0, label.index) + " ".repeat(label[0].length) + text.slice(label.index + label[0].length)
    : text;
  const sha = SHA.exec(masked);
  return {
    repository: label?.[1] ?? null,
    prNumber: label ? Number(label[2]) : null,
    sha: sha?.[1] ?? null,
  };
}
