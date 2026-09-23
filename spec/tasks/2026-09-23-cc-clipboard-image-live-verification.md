---
task: cc-clipboard-image-live-verification
project: Concordia
kind: テスト
created: 2026-09-23
memory_links:
  - spec/feature/discord-image-ingress.md
---
# 貼り付け画像のMIME修正を稼働環境で確認する

## 目的
実体画像とMIMEラベルが食い違う貼り付け画像が、稼働中のDiscord入口からセッションへ届くことを確認する。

## 完了条件
- 配備中のコードとビルド成果物が修正を含むかを確認する。
- 必要なサービス操作は本体フォルダ・Excubitor・Cc claim/release経由で行う。
- 対応形式のMIME不一致画像が正しい拡張子で届き、非画像・未対応形式・CDN・容量制限を維持する。
- ユーザーの実例を確認できなければ単体回帰成功と運用未確認を区別して記録する。

## スコープ (編集可ディレクトリ)
Concordia/src/discord、spec/feature、配備成果物。
