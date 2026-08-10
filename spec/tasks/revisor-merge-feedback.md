---
task: revisor-merge-feedback
project: Concordia
kind: 実装
status: done
created: 2026-08-10T00:00:00.000Z
source_session: lictor-e5925d70-1da2-47d7-a9eb-33d20cf10ee0
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links:
  - src/pr/revisor-merge-outcome.ts
  - src/pr/revisor-merge-confirm.ts
---
# Revisor マージ結果を「行動が決まる形」で返す

## 目的

`POST /v1/prs/local/:id/merge` は Revisor 由来の失敗をすべて
`{"error":"local_pr_merge_failed","detail":"Revisor local PR merge failed"}` に潰していた。
理由を伏せる判断自体は正しい (Revisor の生メッセージは endpoint やローカルパスを含み得る)
が、潰しすぎたことで **成功しているのに失敗に見える 2 つの経路**を誤診断していた。

### 実測した誤診断 2 件 (いずれも 2026-08-10)

| 事象 | 実際 | 見え方 |
|---|---|---|
| Revisor#395 へ明示マージを要求 | 8 秒前に auto-merge が成立済み (`420065f`) | 0.2 秒で `local_pr_merge_failed`。「マージできない」と読めた |
| Peregrinatio#408 のマージ | Revisor は完走し main に入っていた | Cc が 10,020ms / 10,014ms で打ち切り 502。2 回とも「失敗」と報告 |

どちらも「マージできなかった」ではない。前者は**もう終わっている**、後者は**結果が不明**で、
必要な行動 (何もしない / 実状態を読む) は「失敗」から導けなかった。

## 完了条件

- [x] マージ失敗が、呼び出し側の行動が変わる単位に分類されて返ること
      (`already_merged` / `not_open` / `conflict` / `gate_not_passed` / `unauthorized` /
      `unreachable` / `timeout` / `unknown`)
- [x] 返す文面にパスと URL が含まれないこと。生メッセージはサーバ側ログにだけ残ること
- [x] 既にマージ済みの PR へのマージ要求が、失敗ではなく成功 (`already_merged: true`) を返すこと
- [x] マージの上限が読み取りと分かれ、打ち切り後に実状態を読み直して確定させること
- [x] 状態を確認できないときはマージ済みへ寄せないこと (fail-closed)

## スコープ

- `src/pr/revisor-merge-outcome.ts` (新規) — 失敗の分類と秘匿。純関数
- `src/pr/revisor-merge-confirm.ts` (新規) — Revisor 側の実状態の読み直し
- `src/pr/revisor-client.ts` — `RevisorMergeError` を投げる / マージ専用の上限
- `src/api/prs.ts` — 事前確認・分類・打ち切り後の再確認

対象外:

- **マージの非同期化** — 受理だけ返して結果を後から通知する形。打ち切りが構造的に
  消えるが、通知経路と待ち受け UI の設計が要るので本タスクでは扱わない
- Revisor 側のメッセージ文言 — Revisor の責務

## 設計判断

**なぜ生メッセージをそのまま返さないか。** 元の実装のコメントが挙げていた懸念
(endpoint / 設定情報の混入) は妥当で、そこは変えない。分類できた失敗でも、原文には
credentials・個人情報・private endpoint など未知の情報が混入し得る。パスと URL だけを
文字列で伏せても網羅できないため、API には行動を示す定型文だけを返し、生メッセージは
サーバ側ログにだけ残す。

**なぜ打ち切りを「失敗」と呼ばないか。** Concordia が接続を切っても Revisor の
マージ処理は止まらない。打ち切りは Concordia 側の都合であって Revisor 側の結果ではない。
そこで `timeout` は結果不明として扱い、PR の実状態を読み直してから確定させる。
読めなければ失敗として返す (握りつぶさない)。

**なぜ上限を残すか。** 無期限に待つと呼び出し側 (Discord のマージ操作) が固まる。
読み取り 10 秒はそのまま、マージだけ 180 秒に分ける。

**なぜ状態確認を fail-closed にするか。** 「確認できなかった」を「マージ済み」へ寄せると、
未マージの PR をマージ済みと報告することになり、元の誤診断より悪い。

## テスト

- `src/pr/revisor-merge-outcome.test.ts` — 分類 8 種、分類済み・未分類ともに原文を
  漏らさないこと、`RevisorMergeError` 以外を `unknown` に寄せること
- `src/pr/revisor-merge-confirm.test.ts` — id 引き、読み取り失敗時の fail-closed、reader 未注入
- `src/pr/revisor-client.test.ts` — 拒否時に status と原文を保持すること、打ち切りに
  `timedOut` が立つこと、マージの上限が読み取りより長いこと

## 残作業

無し。マージの非同期化を行う場合は別タスクとして起票する。
