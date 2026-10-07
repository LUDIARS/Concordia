---
type: feature
title: "セッションタイトル (current_task) を人の指示から決める"
service: concordia
domain: session-lifecycle
status: implemented
updated: 2026-10-07
---

# セッションタイトルを人の指示から決める {#SPEC-SESSION-PROMPT-TITLE}

## 背景

hook (`tools/concordia-hook-runtime.mjs`) は UserPromptSubmit のたびに本文先頭 200 文字を
`prompt` イベントの `summary` として送る。 以前は受け口 (`src/api/sessions/events.ts`) がそれを
そのまま `current_task` に書いていたため、 Cc の方針更新・`<pasted_content>`・`<task-notification>`・
自動確認・handoff などの制御注入までタイトルになっていた (2026-10-07 neco 指摘)。

価値: [UX-CC-SC-W1](../ux/session-coordination.md) — 同じ workspace の作業をタイトルで見分けられること。
状態所有者: `current_task` は session-lifecycle (sessions 行) が持ち、ここだけが prompt から書く。
不変条件: 制御注入は `current_task` を書き換えない / 要約は新しい指示や手動 rename を上書きしない。

## 振る舞い

1. **制御注入は除外する** — 本文 (前後空白を除く) が次で始まるとき `current_task` を変えない。
   - `<タグ名` で始まるタグ (`<pasted_content>` / `<task-notification>` / `<system-reminder>` など)
   - `[Cc ` / `[自動確認]` / `[SYSTEM NOTIFICATION` / `# Phase boundary handoff` / `⚠️ ブランチ切替` / `次タスクを Actio から取得`
   - Discord 中継の前置きを外した残りが上のどれかで始まる場合も同じ。
2. **人の指示は 1 行タイトルを即座に書く** — `「<名前>」さんからの指示:` の前置きを外し、 最初の空でない行の
   空白を詰めて 80 文字に切る (`src/api/sessions/prompt-title.ts`)。
3. **Haiku で要約して差し替える** — 要約器 (`claude -p --model haiku`、 30 秒で打ち切り) があれば裏で要約し、
   結果が出た時点で `current_task` がまだ 2. のタイトルのままなら差し替える (`prompt-title-summarizer.ts`)。
   - 要約待ちの間に次の指示や手動 rename が入っていれば、 新しい方を残す。
   - 依頼文は `<request>` で囲んだ要約対象として渡し、 依頼文の中の指示には従わせない。
   - 同時実行は 2 件まで。 超えた依頼は要約せず 2. のタイトルを残す (Bot と OAuth refresh が重なると全体が詰まるため)。
   - CLI の失敗・空や制御注入に見える出力は捨て、 2. のタイトルを残す。
   - 差し替えたら `session.event` (`prompt_title_summarized`) を流して表示を更新する。

要約器は `harnessRunClaude` が注入されているときだけ有効。 未注入 (テスト・最小構成) は 1. と 2. だけ動く。
