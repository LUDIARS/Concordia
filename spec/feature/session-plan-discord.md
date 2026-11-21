---
type: feature
title: "セッションのプランを Discord へ出す (provider 共通)"
service: concordia
domain: session-lifecycle
status: implemented
updated: 2026-11-21
---

# セッションのプランを Discord へ出す (provider 共通) {#SPEC-SESSION-PLAN-DISCORD}

> 所属ドメイン: [`session-lifecycle`](../domains/session-lifecycle.domain.json)

## 目的

作業のプラン (手順のリスト) とターンの終わりのサマリを、 セッションの Discord スレッドへ出し、 セッションの状態を
プランに合わせて表示する。 離れた場所から進み具合を追えるようにする。 最初はデスクトップの Claude アプリ向けに
作った ([`desktop-plan-discord.md`](desktop-plan-discord.md)) が、 Antigravity CLI (agy) のセッションでも同じ投稿を
出すため、 状態・投稿の処理を送り手に依らない形にまとめた (2026-11-21 neco 指示「共通化して」「agy にプランを送らせる」)。

## 送り手

| 送り手 | 送り方 | 詳細 |
|---|---|---|
| デスクトップの Claude アプリ | hook がアプリの MCP ツール `update_plan` / `wrap_up` を見分けて自動で送る | [`desktop-plan-discord.md`](desktop-plan-discord.md) |
| agy | agy 自身がコマンド実行ツールから `tools/session-plan.mjs` を呼ぶ (起動案内で指示する) | [`agy-harness-hook.md`](agy-harness-hook.md) |

どちらも同じ口 `POST /v1/sessions/:id/event { kind: "desktop_plan", payload: { tool, input } }` に届ける。
`tool` は `update_plan` / `wrap_up`、 `input` はアプリのツールと同じ形。 kind と保存先 (`metadata.desktop_plan`) の
名前はデスクトップ版から据え置く (既存の hook・保存済みのプランをそのまま読むため)。

## 状態 (`src/session-plan/plan-state.ts`)

- 更新は差分で届く (全体の置き換え `items` / 次へ進める `advance` / 番号で完了 `done`・開始 `start`)。
  Concordia が直前の状態に当ててプラン全体を組み立て直し、 `metadata.desktop_plan` に保存する。
- `wrap_up` はステップを全部済みにして閉じる。 `blocked` なら「回答待ち」、 それ以外は「完了」。
- セッションの状態の 1 行は `metadata.desktop_plan.status` に持つ。
  - 作業中: `作業中 (n/N): <進行中のステップ>`
  - サマリの後: `完了` / `回答待ち`
- ステップは `session_task_records` にも写す。 Discord の状態カードの「タスク」欄と残作業の判定がそのまま読む。

## 投稿 (`src/session-plan/plan-posts.ts`)

- 状態が変わったとき (プランが出た・進行中のステップが変わった・ステップの中身が変わった) に、 プラン全体を
  セッションのスレッドへ投稿する。 変わらない更新は投稿しない。
- サマリ (`wrap_up`) は毎回投稿する。 要約・済んだステップ・人への質問と選択肢を出す。
- 投稿は `session_id` 付きの system 投稿。 egress がセッションのスレッドへ送る。
- 作者ラベルはセッションの provider で決める: `antigravity-cli` は `agy プラン`、 それ以外は `Claude プラン` (従来どおり)。

## 応答

- `kind: "desktop_plan"` のときだけ、 応答に反映の結果 `plan: { status, posted }` を足す。 payload の形が違って
  反映できなかったときは `plan: null` (送り手が失敗として扱えるように)。 他の kind の応答は `{ ok: true }` のまま。

## 送り口の CLI (`tools/session-plan.mjs`)

- `node tools/session-plan.mjs update --file=<input.json> | --json='<JSON>'` / `wrap-up ...`。
- セッションは env の `CONCORDIA_SESSION_ID` → `LICTOR_SESSION_ID` の順で決める。
- 送信は hook と同じ runtime (`tools/concordia-hook-runtime.mjs` の `postSessionEvent`) で行い、 接続先・タイムアウト・
  不達の判定を共有する。
- 失敗は非 0 で終え、 理由を 1 行 stderr に出す。 セッション ID が無い・active な登録が無い・Concordia に届かない・
  受け付けられない → 1。 引数・JSON の誤り、 Concordia が `plan: null` を返した → 2。 hook と違い黙って成功にしない。

## 起動案内 (`src/session-plan/plan-guidance.ts`)

- provider が `antigravity-cli` のセッションの起動案内に `[Cc session plan]` を足す: 複数手順の作業ではまずプランを送る、
  手順が進むたび更新、 終わりに wrap-up、 短い返答はプラン不要、 と CLI の呼び方 (絶対パス) と非 0 の扱い。
- 他の provider には足さない。 起動案内の版 (revision) を変えないよう、 フィールド自体を持たせない。

## 範囲外

- Discord からアプリのセッションへの注入・質問への回答。
- 置き換えで消えたステップを `session_task_records` から消すこと (未完了のまま残る)。
- agy がプランを送ったかの強制 (案内のみ。 送らなければ従来どおり投稿は出ない)。
