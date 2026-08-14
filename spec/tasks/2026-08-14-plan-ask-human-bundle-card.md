---
task: plan-ask-human-bundle-card
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/director.md
  - spec/tasks/2026-08-13-plan-gate-discord.md
---
# Director Decision Request の ask_human 分を設問カード 1 枚に束ねて投稿する

## 目的

2026-08-13-plan-gate-discord の完了条件のうち「Decision Request が Genius へ取り次がれ、
ask_human 分だけが設問カード 1 枚に束ねられて投稿される」が未実装。
`DirectorService.requestDecision` は API route から呼ばれるだけで、
`ask_human` 出力を消費して Discord へ設問カードを投稿する経路が存在しない。

## 完了条件

- Director Decision Request の結果が `ask_human` となった項目が、
  1 枚の設問カードに束ねられて所定チャンネルへ投稿される。
- 選択肢には `[A]` 形式のコードが振られ、ボタンまたはテキスト返信の
  どちらでも回答できる。
- 回答が該当 decision へ反映され、step 遷移が進む。
- 投稿・回答反映・不正回答拒否の単体テストが green。

## スコープ (編集可ディレクトリ)

- `src/director/`
- `src/discord/`
- `src/api/`
- 対応するテストファイル
