/**
 * Revisor クライアントが受け取る token 指定を「都度解決する関数」に正規化する。
 *
 * @implements spec/feature/revisor-local-pr-submission.md — 6. token
 *
 * 文字列で受けると起動時の値に固定されてしまい、 Web UI から設定を変えても
 * プロセスを再起動するまで効かない。 関数で持てば設定変更が次のリクエストから効く。
 */
export function toTokenResolver(token?: string | (() => string | undefined)): () => string {
  if (typeof token === "function") return () => token()?.trim() ?? "";
  const fixed = token?.trim() ?? "";
  return () => fixed;
}
