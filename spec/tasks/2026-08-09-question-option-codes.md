---
task: question-option-codes
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 質問カードの選択肢に [A] コードを振る

## 目的

テキスト返信で「どの選択肢か」を一意に指せるようにする (2026-08-09 neco 指示)。
解釈側は Lictor (`fix/ask-marker-answer-capture`)。Concordia は表示だけを担う。

## 完了条件

- Discord (embed / ボタン / セレクト)、Slack (選択肢行 / ボタン)、WebUI (単一 / 複数選択) に
  `[A]` 形式のコードが出る。
- コード生成規則が 1 箇所 (`src/shared/option-code.ts`) にあり、WebUI 側も同じ規則。
- 仕様が `spec/feature/question-option-codes.md` にある。

## スコープ (編集可ディレクトリ)

- `src/shared/option-code.ts`, `src/discord/question.ts`, `src/slack/render.ts`
- `web/src/lib/option-code.ts`, `web/src/pages/session-detail/SessionModals.tsx`
- `spec/feature/`
