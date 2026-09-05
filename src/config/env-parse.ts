/**
 * env 文字列を型付き値へ変換する純粋関数群。
 *
 * 「どのキーを読むか」 は各設定モジュール (workspace-roots / service-urls / …) の責務で、
 * ここは 「文字列をどう解釈するか」 だけを持つ。 同じキーを複数の呼び出し元が
 * 別々の書き方 (`?? ""` / `|| default` / `!== "0"` / `=== "1"`) で読んで解釈が割れる、
 * というのが集約前の実害だったので、 解釈規則をこの 1 ファイルに固定する。
 */

/**
 * 前後空白を落とし、 空文字なら undefined を返す。
 *
 * 未設定 (`undefined`) と空文字 (`FOO=`) を同じ 「未指定」 として扱うための正規化。
 * env を空文字で渡すのは 「消したつもり」 であることがほとんどで、 空 base URL や
 * 空パスをそのまま採用すると原因の分かりにくい失敗になる。
 */
export function trimmedEnv(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 既定 ON のフラグ。 `"0"` のときだけ OFF (それ以外の値・未設定は ON)。 */
export function readFlagDefaultOn(raw: string | undefined): boolean {
  return raw !== "0";
}

/** 既定 OFF のフラグ。 `"1"` のときだけ ON。 */
export function readFlagDefaultOff(raw: string | undefined): boolean {
  return raw === "1";
}

/** `;` 区切りの列を trim + 空要素除去で配列化。 */
export function splitSemicolonList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** base URL の末尾スラッシュを全て落とす (`http://h/` と `http://h` を同一視する)。 */
export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * TCP ポート番号として読む。 未設定 (空文字含む) は undefined。
 *
 * 不正値は**投げる**。 ポート指定を黙って既定へ落とすと、 設定したつもりの
 * ポートと実際の接続先が食い違ったまま起動してしまい、 原因の分かりにくい
 * 疎通失敗になる。 どのキーが壊れているかを追えるよう `envKey` を文面に出す。
 */
export function readPortEnv(raw: string | undefined, envKey: string): number | undefined {
  const normalized = trimmedEnv(raw);
  if (!normalized) return undefined;
  const port = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${envKey} must be an integer between 1 and 65535`);
  }
  return port;
}
