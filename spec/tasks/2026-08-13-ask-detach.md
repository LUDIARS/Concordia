---
task: ask-detach
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/deterministic-teardown.md
---
# 未回答質問とプロセスの寿命分離 (ask detach)

## 目的
未回答 ask で止まったパートタイマーを blocked 化して畳み、回答後に新規 run で再開する
(deterministic-teardown §4)。

## 完了条件
- 未回答 ask が `CONCORDIA_ASK_DETACH_SEC` (既定 1800) を超えた run が blocked になり、
  質問カードは残したままセッションが teardown ladder で畳まれる。
- 質問カードに「回答すると新しい run で再開します」が追記される。
- 回答受信で、回答内容を初回指示 context に含む新規 run が起案され、blocked run の
  worktree / branch を引き継ぐ。
- persona-context に「前提が欠けたら質問せず『前提未確定』として PR 本文に明記して
  completed 報告。質問は権限・破壊的操作カテゴリのみ」が追記される。
- detach → 回答 → 再開の一連の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/taskflow/
- src/control/
- src/delegation/
- src/discord/
