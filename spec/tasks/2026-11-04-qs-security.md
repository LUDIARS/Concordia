---
task: qs-security-20261104
project: Cc
kind: implementation
created: 2026-11-04
source_session: lictor-99f00212-bbf7-4492-ad88-c948435f4401
---
# qs の固定版を要求レンジ内の 6.16.2 に更新

## 実装内容

Actio 参照: actio:50d03d12-f65c-4a93-b6bc-2116e1324999
qs 6.16.0 の固定情報 3 項目だけを 6.16.2 に更新。body-parser (^6.15.2) と express (^6.14.0) の要求を維持し、間接依存も維持する。
再利用探索: 既存の qs parser と npm lockfile を採用。親依存の互換性を守るため独自 parser への置換や overrides は採用しない。
既存 tooling 境界に lock 差分の純関数・契約述語・対の回帰テストを追加。UX-CC-W5 / UX-CC-S6、CC-INV-04/05。業務状態の変更なし。復旧は変更の revert。

## 受け入れ条件

C-1 verifyQsLockUpdate(before,after): qs の指定版への変更だけを許可し、それ以外の lock 情報と親要求レンジを維持する。
検証: 対象テスト 5 件成功、Augur 契約 observed 5 / violations 0。配布 tarball の SHA-512 と registry integrity が一致。配布物で通信・動的実行の候補なし。install/postinstall なし、ライフサイクルスクリプト未実行。
全体スイート・サービス操作は依頼範囲外のため未実施。
