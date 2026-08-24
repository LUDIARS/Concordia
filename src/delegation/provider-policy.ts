/**
 * Delegation provider policy.
 *
 * 2026-08-22〜24 は Windows native Codex の CreateProcessWithLogonW ログオン
 * セッションリークを避けるため、logical provider "codex" を強制的に
 * Satelles/SDK レーン ("codex-sdk") へ書き換えていた。2026-08-25 に方針転換:
 * WSL/Satelles 経路が codex 認証ローテーションと lsass クラッシュで継続不能に
 * なったため、native Codex (ターミナル実行 + sandbox 起動を外す運用) を正規
 * レーンへ戻し、この境界は書き換えを行わない pass-through にする。
 * 呼び出し箇所 (persistence / invocation) は将来の方針変更に備えて維持する。
 *
 * @implements spec/feature/delegation.md §4
 */
export function applyDelegationProviderPolicy<TProvider extends string>(
  provider: TProvider,
): TProvider {
  return provider;
}
