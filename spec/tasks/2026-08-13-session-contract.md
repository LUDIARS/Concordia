---
task: session-contract
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/session-contract.md
---
# セッション契約 (model-review 統合 + 三段判定 + 質問カード)

## 目的
spawn / 初回指示 / task-change 時の全作業条件を 1 つの型付き契約として確定する
(session-contract 全節)。

## 完了条件
- `src/contract/` (schema / seed-rules / review-port / question-bridge) が新設され、
  契約が `sessions.metadata.contract` + `session_events kind:"contract"` に永続化される。
- seed で決まるフィールドは LLM に渡らず、LLM 出力は zod 検証を通った値だけが載る。
- 未決フィールドが 1 枚の質問カードに束ねられ、ボタン / `[A]` テキスト返信で回答でき、
  回答のたび契約へ反映される。
- 既存 model-review の model/effort 判定が契約フィールドとして吸収され、単発
  `mreview:` ダイアログが撤去される。
- ハーネス述語 `contract-incomplete` が未確定セッションのコード編集を deny する
  (.md / spec / docs 除外)。
- `GET/PATCH /v1/sessions/:id/contract` と人間上書き最優先が動く。
- delegation invoke の model / effort / branch / cwd が契約から読まれる。
- 三段判定・検証落ち・上書きの単体テストが green。

## スコープ (編集可ディレクトリ)
- src/contract/
- src/model-review/
- src/api/
- src/harness/
- src/discord/
- src/delegation/
- src/db/
