---
type: feature
title: "Delegation 段階注入 — 調査ブリーフ → 実装タスク"
description: "実装委託の初回 inject を「調査ブリーフ」に限定し、委託先の調査報告を受けてから理由 (why)・実装タスク・Memoria タスク・完了条件を 1 通にまとめて後追い inject する。初回/後追いの重複・再起動・再送は delegation_runs の列で冪等に扱う。"
service: concordia
domain: governance
tags:
  - delegation
  - inject
  - memoria
  - idempotency
  - sqlite
status: implemented
updated: 2026-08-13
---

# Delegation 段階注入 — 調査ブリーフ → 実装タスク

## 1. 動機 (問題)

実装委託の初回プロンプトは、これまで次の 2 つを同時に渡していた。

1. タスク本文の丸投げ (`rendered_prompt` そのもの)
2. 協調コンテキストの「勝手に作業しない」節
   — *「方針が複数あり得る / スコープが曖昧 / 影響が大きい場合は、着手前に方針を示してユーザの承認を待つ」*

この 2 つは実装委託では両立しない。まともな実装タスクはほぼ必ず「方針が複数あり得る」から、
慎重なモデル (Claude / Opus) は auto permission mode であっても**初回ターンで質問を返して停止する**。
しかも委託元はその時点で調査結果を持っていないので、その質問には答えようがない。
結果として「委託したのに 1 ターン目で止まっている」状態が量産された。

根本原因は permission の設定ではなく、**固定初期 inject の責務境界**にある。
初回 inject が「タスク + 承認待ちの姿勢」を同時に渡していることが問題で、
Claude native auto permission の判断は Lictor #332 の責務。本仕様はそこには触れない
(許可の強制 allow/deny も watchdog の再有効化も行わない)。

## 2. 設計 (2 段階に割る)

| 段階 | いつ | 渡すもの | 渡さないもの |
|------|------|----------|--------------|
| 第 1 段階 (調査ブリーフ) | spawn 時の prompt file | 対象リポジトリ / branch、安全境界、調査姿勢、調査テーマ 1 行、報告 API | タスク本文、理由、完了条件 |
| 第 2 段階 (実装タスク) | 調査完了報告を受けて | 理由 (why)、タスク本文、Memoria タスク id/link、完了条件 | — |

姿勢も段階で切り替える (`persona-context.ts` の `DelegationPosture`)。

- `approval` (既定・従来): 方針が複数あり得るならユーザ承認を待つ。
- `investigation` (第 1 段階): **まず調べる。通常の不明点で停止しない。**
  停止して質問してよいのは (a) 外部権限が必要なとき (b) 本当に不可逆な選択のとき の 2 つだけで、
  いずれも調べた事実を根拠として添える。それ以外 (どのファイルか / 命名 / 実装順序 /
  テストの粒度) はコードと spec を根拠に自分で決める。

両者は排他。`approval` の文言を残したまま調査ブリーフを渡すと、委託先は矛盾を安全側に
解釈して結局初回で止まる — これが 1 章の問題そのものなので、切り替えは排他で行う。

### 2.1 適用条件

`decideStagedInjection()` (純関数) が決める。3 つすべてを満たすときだけ段階注入。

- 設定 `admin.delegation_staged_injection_enabled` が有効 (既定 true)
- Inject マニュアル kind が `実装` (レビュー / 設計相談 / テスト / 雑用 は対象外 —
  調査ブリーフの安全境界 (worktree / commit / PR) が噛み合わない)
- 対象リポジトリ (cwd) が解決できている (「どこを調べるか」が書けないため)

適用しなかった場合は理由付きで `log.info` に残す (無言フォールバック禁止)。

## 3. API

| Method | Path | 用途 |
|--------|------|------|
| POST | `/v1/delegation/runs/:id/investigated` | 第 2 段階のトリガ (委託先が調査完了を報告する) |

リクエスト:

```json
{ "summary": "分かったこと 3-5 行", "files": ["調べた主要ファイル"], "blockers": ["外部権限が要る事項"] }
```

レスポンス:

```json
{
  "ok": true,
  "target_session_id": "…",
  "delivered": true,
  "already_delivered": false,
  "memoria_task_id": "123",
  "memoria_task_url": "http://127.0.0.1:5180/api/tasks/123",
  "memoria_error": null,
  "supplement_delivered": false
}
```

エラー:

- `404 not_found` — run が無い
- `409 run_not_staged` — 段階注入で起動していない run (タスクは初回プロンプトで配信済み)
- `404 child_session_not_found` / `409 child_session_not_claimed` / `409 child_session_not_connected`
  — `/runs/:id/inject` と同じ接続ガードを共有する (未接続の inject は静かに消えるため成功扱いにしない)

## 4. 冪等性

状態は `delegation_runs` の列に持つ (in-memory Set は Cc 再起動で抑止が外れる)。

| 列 | 意味 |
|----|------|
| `staged_injection` | 1 = 段階注入で起動した run |
| `staged_followup_at` | 実装タスクを配信した時刻 (epoch-ms)。null = 未配信 |
| `investigation_summary` | 委託先から届いた調査報告 (証跡) |
| `memoria_task_id` / `memoria_task_url` | 関連付けた Memoria タスク |

2 つの副作用を**独立に**冪等化する。

- Memoria タスク作成 … `memoria_task_id IS NULL` の UPDATE が成功したときだけ (自分が作成者)
- 実装タスクの inject … `staged_followup_at IS NULL` の UPDATE が成功したときだけ (自分が配信者)

配信は **mark → inject** の順。逆にすると同時到着した 2 本がどちらも「未配信」を見て二重配信する。

再送 (同じ run へ 2 回目以降の報告) は実装タスクを再配信しない。ただし 1 回目に Memoria が
落ちていて 2 回目で作成に成功した場合だけ、id を伝える短い補足 inject を送る
(`supplement_delivered: true`)。

## 5. Memoria との責務境界

Memoria 側は**変更しない**。Concordia は既存の公式 API (`POST /api/tasks`) だけを使う。

- 委託元が `args.memoria_task_id` (または `memoria_task` / `task_id`) を渡していれば、
  新規作成せずその id を関連付ける (二重起票の回避)。
- 無ければ `title` / `details` だけの最小ペイロードで作成する。カテゴリや期日は
  Memoria 側の語彙なので推測しない。
- リンクは契約済みの API リソース URL (`<base>/api/tasks/:id`)。Web UI の画面パスは
  Memoria の実装詳細なので推測しない。
- Memoria が落ちていても実装は止めない。追跡タスクが無い事実を follow-up 本文に明記し
  (「未作成: <理由>」)、完了報告に含めるよう指示する。

## 6. 責務の所在

| 関心事 | 置き場所 |
|--------|----------|
| 何を書くか (文面) | `src/delegation/staged-injection.ts` (純関数) |
| いつ送るか / 二重送信の抑止 / Memoria 連携 | `src/delegation/staged-followup.ts` |
| 永続状態 | `delegation_runs` の列 (migration 62) |
| 姿勢の切り替え | `src/delegation/persona-context.ts` (`DelegationPosture`) |
| 適用判断と第1段階の差し込み | `src/delegation/service.ts` |
| HTTP 面と接続ガード | `src/api/delegation.ts` |

本仕様が触らないもの: Claude native auto permission (Lictor #332 の責務)、
delegation run watchdog (`run-watchdog.ts` — 列も挙動も変更しない)。

## 7. 設定

`admin.delegation_staged_injection_enabled` (既定 true)。`AdminState.snapshot()` に
`delegation_staged_injection_enabled` として出る。明示 OFF で従来の一括注入へ戻る。
