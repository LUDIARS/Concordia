---
task: plan-gate-discord
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/plan-gate.md
---
# プランゲート Discord UI (設問カード束ね + 設計カード + 修正 Modal)

## 目的
設問→設計→修正判断を Discord 上のカード操作で回す (plan-gate §2.1, §2.2)。

## 完了条件
- Decision Request が Genius へ取り次がれ、ask_human 分だけが設問カード 1 枚に束ねられて
  投稿される (Genius 回答分は監査ログのみ)。
- 設計カード (プラン全文/要約 embed + `[承認して実行] [修正指示] [破棄]`) が投稿され、
  修正指示 Modal の内容がセッションへ inject → v2 カード投稿 → 旧カードが
  「改訂済み」表記に編集される。
- ボタン操作と `[A]` テキスト返信の両方で承認・回答が完結する (relay 対応)。
- カード描画・interaction・版遷移の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/discord/
- src/director/
- src/inquiry/
