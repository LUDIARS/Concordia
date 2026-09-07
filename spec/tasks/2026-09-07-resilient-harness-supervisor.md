---
task: resilient-harness-supervisor
project: Concordia
kind: 実装
created: 2026-09-07
memory_links: []
---

# Cc不在時にも復旧可能なハーネス監督処理

## 目的

中央ゲートへの接続失敗が復旧実装まで阻害する循環依存を解消する。

## 完了条件

- Cc稼働中は中央判定を利用し、オンラインdenyを迂回しない。
- 独立して配布可能なスクリプトと、対象・セッション・鮮度を照合するローカルキャッシュを用意する。
- キャッシュがない場合も、明示設定された復旧対象とコマンドを既存安全規則の範囲で判定する。
- オフライン動作を監査し、再接続時は中央の最新設定に戻る。
- 配置手順と制約を明示し、既存の中央依存hookと二重に判定させない。

## スコープ (編集可ディレクトリ)

src/harness/、src/api/、tools/、package.json、tsconfig.harness.json、spec/。別repoへの配布・既存hook置換は対象登録と共有差分確認をして扱う。
