---
type: feature
title: "デスクトップの Claude アプリのプランを Discord へ出す"
service: concordia
domain: session-lifecycle
status: implemented
updated: 2026-11-21
---

# デスクトップの Claude アプリのプランを Discord へ出す {#SPEC-DESKTOP-PLAN-DISCORD}

> 所属ドメイン: [`session-lifecycle`](../domains/session-lifecycle.domain.json)

## 目的

デスクトップの Claude アプリは、 作業のプラン (タスクのリスト) とターンの終わりのサマリをアプリの中にだけ出す。
離れた場所から進み具合を追えるように、 同じ内容をセッションの Discord スレッドへ出し、 セッションの状態を
プランに合わせて表示する (2026-11-21 neco 指示)。

状態・投稿・応答の処理は provider 共通の [`session-plan-discord.md`](session-plan-discord.md) (SPEC-SESSION-PLAN-DISCORD) に
まとめた。 この文書はデスクトップアプリからの取り込みを定める。 下の「状態」「投稿」は共通仕様の要約。

## 取り込み

- アプリはプランを MCP ツール `mcp__ccd_turn__update_plan` (作業中) と `mcp__ccd_turn__wrap_up` (サマリ) で更新する。
- `tools/concordia-hook.mjs tool-result` (PostToolUse) がこの 2 つを見分け、 入力をそのまま
  `POST /v1/sessions/:id/event { kind: "desktop_plan", payload: { tool, input } }` で届ける。
- アプリのセッションは Lictor を通らないので Concordia に登録が無い。 プラン更新を見た hook が、 そのセッションを
  観測専用 (`metadata.cc_hook_observation` / `metadata.desktop_app`) で登録してから届ける。 プラン更新以外の
  ツールでは登録しない (sub-agent や one-shot CLI を自動登録しない従来の方針のまま)。

## 状態

- 更新は差分で届く (全体の置き換え `items` / 次へ進める `advance` / 番号で完了 `done`・開始 `start`)。
  Concordia が直前の状態に当ててプラン全体を組み立て直し、 `metadata.desktop_plan` に保存する。
- `wrap_up` はステップを全部済みにして閉じる。 `blocked` なら「回答待ち」、 それ以外は「完了」。
- セッションの状態の 1 行は `metadata.desktop_plan.status` に持つ。
  - 作業中: `作業中 (n/N): <進行中のステップ>`
  - サマリの後: `完了` / `回答待ち`
- ステップは `session_task_records` にも写す。 Discord の状態カードの「タスク」欄と残作業の判定がそのまま読む。

## 投稿

- 状態が変わったとき (プランが出た・進行中のステップが変わった・ステップの中身が変わった) に、 プラン全体を
  セッションのスレッドへ投稿する。 変わらない更新は投稿しない。
- サマリ (`wrap_up`) は毎回投稿する。 要約・済んだステップ・人への質問と選択肢を出す。
- 投稿は `session_id` 付きの system 投稿 (作者 `Claude プラン`。 provider ごとのラベルは共通仕様)。 egress がセッションのスレッドへ送る。

## 範囲外

- Discord からアプリのセッションへの注入・質問への回答 (アプリのセッションは観測専用)。
- 置き換えで消えたステップを `session_task_records` から消すこと (未完了のまま残る)。
