---
type: feature
title: "セッションタイトル (current_task) を人の指示から決める"
service: concordia
domain: session-lifecycle
status: implemented
updated: 2026-10-16
---

# セッションタイトルを人の指示から決める {#SPEC-SESSION-PROMPT-TITLE}

## 背景

hook (`tools/concordia-hook-runtime.mjs`) は UserPromptSubmit のたびに本文先頭 200 文字を
`prompt` イベントの `summary` として送る。 以前は受け口 (`src/api/sessions/events.ts`) がそれを
そのまま `current_task` に書いていたため、 Cc の方針更新・`<pasted_content>`・`<task-notification>`・
自動確認・handoff などの制御注入までタイトルになっていた (2026-10-07 neco 指摘)。

価値: [UX-CC-SC-W1](../ux/session-coordination.md) — 同じ workspace の作業をタイトルで見分けられること。
状態所有者: `current_task` は session-lifecycle (sessions 行) が持ち、ここだけが prompt から書く。
不変条件: 制御注入・文脈不明・要約失敗は `current_task` を書き換えない / 要約は新しい指示や手動 rename を上書きしない。

## 振る舞い

1. **制御注入は除外する** — 本文 (前後空白を除く) が次で始まるとき `current_task` を変えない。
   - `<タグ名` で始まるタグ (`<pasted_content>` / `<task-notification>` / `<system-reminder>` など)
   - `[Cc ` / `[自動確認]` / `[SYSTEM NOTIFICATION` / `# Phase boundary handoff` / `⚠️ ブランチ切替` / `次タスクを Actio から取得`
   - Discord 中継の前置きを外した残りが上のどれかで始まる場合も同じ。
2. **確定まで既存タイトルを維持する** — 前置きを外して依頼を分類するが、先頭行を代替タイトルとして保存しない。
3. **文脈を確認できた要約のみ反映する** — Haiku に既存タイトルと依頼文をJSONのデータとして渡す。
   出力は `{ "understood": true, "title": "40文字以内の作業内容" }` に限定する。
   文脈不足・対象不明・短い相槌・選択肢回答だけなら understood=false とする。
   - 構造不正、understood欠落/false、説明文、空、複数行、制御注入、CLI失敗/例外/30秒打切り、同時実行上限2件、要約器未注入は既存名を維持する。
   - 初回も同じ規則とし、文脈が不明ならタイトル未設定のままにする。手動renameは通常どおり利用できる。
   - 新しい人間入力は以前の待機結果を無効化する。新入力が名前を変えない場合も同様。
   - 結果反映前に読み取り時の既存名と一致することを確認し、手動変更を上書きしない。
   - pendingの識別子はstore単位のWeakMapで保持し、完了/失敗で除去する。再起動で未反映の要約を失っても既存名は保持される。
   - 差し替えたら `session.event` (`prompt_title_summarized`) を流して表示を更新する。

2026-10-16 neco指示に基づく変更。Actio `2f7db92d-a189-42ae-b3dd-940ce34a0189`。
所有境界は既存session-lifecycle、価値UX-CC-SC-W1、不変条件CC-INV-01/08。モデルによる理解判定の完全性は保証しない。
復旧は本変更を差し戻す。既存のタイトル・手動設定・履歴の削除やDB移行は不要。
ローカルの実行テストと実機評価は未実施。回帰テストを追加し、実行は通常のRevisor審査経路で確認する。
