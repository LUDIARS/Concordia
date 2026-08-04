# Revisor PR #140 の登録テストが2件失敗

## 概要

- 発生日: 2026-08-04
- 対象: Concordia / Revisor local PR #140
- 症状: rebase後の登録テストで `provider-preset.test.ts` と `test-forum-reconcile.test.ts` が1件ずつ失敗した。

## 原因

1. Vitest は `isolate: false` でmodule registryを共有するため、logger moduleをファイル単位でmockするテストは、別テストが先に実moduleを読み込むと対象moduleのloggerを差し替えられなかった。
2. Test Forum候補の安全なspawn先は Revisor product の登録済み `headRef` を正本に変更したが、fixtureはdetail側の異なる `headRef` を期待したままだった。

## 対応

- `resolveDelegationRuntimeArgs` に既定値付きのwarning logger注入口を追加し、テストはmodule mockではなく呼出単位のspyを渡すようにした。
- Test Forumの期待値を product fixtureの `feat/test-forum` に合わせた。実装は変更せず、登録済みproductをspawn targetの正本とする設計を維持した。

## 検証

- 変更差分と `git diff --check` を静的に確認する。
- セッション方針に従い、ローカルテストは実行しない。Revisorの登録済みテストで再確認する。

## 再発防止

module registryを共有するテストでは、module読込時に確定するloggerを `vi.mock` で差し替えず、既定実装を持つ依存注入で観測する。複数APIから同じfieldを得られる場合は、実装が採用する正本とfixtureの期待元を一致させる。
