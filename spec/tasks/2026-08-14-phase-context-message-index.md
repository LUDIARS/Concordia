---
task: phase-context-message-index
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/tasks/2026-08-13-phase-compaction.md
  - spec/tasks/2026-08-13-plan-gate-discord.md
---
# フェーズ文脈の message-id 索引層を実装する

## 目的

2026-08-13-phase-compaction の三層文脈のうち message-id 索引層が未実装。
`buildPhaseContext` (`src/control/phase-compaction.ts`) は
`metadata.discord_plan_message_id` / `discord_question_message_id` を読むが、
これらを書き込む箇所がリポジトリ内に存在せず、常に null になる。
設問回答の内容もフェーズ文脈に含まれていない。

## 完了条件

- プランカード・設問カードの投稿時に、その message id がセッション metadata の
  `discord_plan_message_id` / `discord_question_message_id` へ記録される。
- フェーズ文脈 (索引) に契約カード・プラン最新版・設問回答・直近 handoff が載り、
  カード探索なしで組み立てられる。
- message id 記録と文脈組み立て (回答含む) の単体テストが green。

## スコープ (編集可ディレクトリ)

- `src/discord/`
- `src/control/`
- `src/db/`
- 対応するテストファイル
