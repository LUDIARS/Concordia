---
task: 2026-10-01-session-language-guard
project: Concordia
kind: 実装
created: 2026-10-01
memory_links: []
---
# 英語に流れたセッションを日本語へ戻す inject (言語補正)

設計正本: `spec/feature/session-language-guard.md`。2026-10-01 neco 指示「FINAL ANSWER の英語を受け取る前にフックか何かで
日本語で補正できるような inject を入れてほしい」。

## 目的

Opus が途中発言から英語に流れたとき、最終回答の前に日本語へ戻す。最終回答まで英語だった場合も日本語の言い直しを受け取れるようにする。

## 完了条件

- [ ] assistant の発言が英語かを判定する純関数 (コード・URL・パスを除き、英単語数とひらがな数で判定)。
- [ ] 英語の発言を見たら `auto:language-guard` で日本語の補正を 1 回 inject し、日本語に戻るか人間の発言が届くまで再送しない。
- [ ] 未回答の質問・active でないセッション・再放流された古い発言には送らない。
- [ ] 設定 `session.language_guard_enabled` (既定 ON) で止められる。
- [ ] 判定・補正・配線のテストを同じ変更で書き、`cc.acceptance.json` に対応付ける。

## スコープ (編集可ディレクトリ)

- `src/control/`、`src/admin/`、`src/config/settings/`、`src/bootstrap/`、`spec/`
