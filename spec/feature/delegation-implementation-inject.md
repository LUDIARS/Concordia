---
type: feature
title: "Delegation 実装委託の 1 通注入 — why + タスク + Memoria + 完了条件"
description: "実装委託の初回 inject で、理由 (why)・タスク本文・Memoria 追跡タスク・完了条件を 1 通にまとめて渡す。事前の調査ブリーフ工程 (段階注入) は廃止し、コードベース把握は委託先が Anatomia の解析グラフで自走する。完了報告まで終えたら委託先はその場で session-end する。"
service: concordia
domain: governance
tags:
  - delegation
  - inject
  - memoria
  - anatomia
  - lifecycle
status: implemented
related:
  - delegation.md
  - feature/task-workflow.md
updated: 2026-08-21
---

# Delegation 実装委託の 1 通注入

> 2026-08-21 neco 指示。 委託タスクの終わり方が不安定なので、 二段階のタスク渡しをやめる。
> 調査ブリーフは Anatomia の解析グラフを探せば済む。 タスクが終わったらとっとと
> end-session し、 次をやらないよう指示する。

## 1. 経緯 — 段階注入 (2026-08-13〜2026-08-21) の廃止

実装委託の初回 inject を「調査ブリーフ」に限定し、 委託先の調査報告
(`POST /v1/delegation/runs/:id/investigated`) を引き金に実装タスクを後追い配信していた。
これは「初回ターンで質問を返して停止する」問題への対策だったが、 段階そのものが新しい
停止点を作った。

- 第 1 段階で調査報告を返さずに止まる / 報告 API を呼ばずに実装へ進む。
- 非対話 runner (codex-sdk = Satelles `run`) は 1 ターンで終了し、 第 2 段階が届かない。
  run は `completed`、 commit ゼロ — 見た目が成功する沈黙故障。
- 委託元 (人間) から見ると「終わったのか止まっているのか分からない」状態が残る。

停止の真因は段階の有無ではなく**作業姿勢の文言**だった (「方針が複数あり得るなら承認を待つ」)。
姿勢の側を一本化 (§3) すれば段階は要らない。 コードベース把握は Anatomia の解析グラフで
委託先が自走できるため、 Concordia が調査を待ち受ける工程を持たない。

廃止したもの: `/v1/delegation/runs/:id/investigated`、 `staged-followup.ts`、
設定 `workflow.delegation_staged_injection_enabled`、 調査ブリーフ本文。
`delegation_runs` の列 (`staged_injection` / `investigation_summary` / `staged_followup_at`)
は既存行の読み出しのためだけに残す (新規 run は常に非段階)。

## 2. 初回 inject の中身 (delegation/implementation-inject.ts)

kind (manual-kind) が `実装` の委託は、 `## Prompt` 節を次の構成で組み立てる。

1. `なぜ (why)` — args の `why` / `reason` / `problem` / `background` → 既定文の順で解決。 LLM は介在しない。
2. `実装タスク` — `rendered_prompt` 全文 (伏せない)。
3. `着手前の把握` — Anatomia 解析グラフ (`/anatomia-analyze` → `find` / `where` / `context`) と
   `spec/` / `spec/tasks/` を自分で引く。 調査報告して指示を待つ工程は無い。
4. `Memoria タスク` — 起票済みなら id + link、 失敗なら理由 (黙って省略しない)。
5. `完了条件` — 仕様更新 / 実装 / 回帰テスト / commit / Revisor local PR / status 報告。
6. 安全境界 — worktree 内のみ・main 直コミット禁止・無関係な未コミット変更に触れない・
   サービス起動禁止・merge は明示指示があるまでしない。

実装以外の kind (レビュー / 設計相談 / テスト / 雑用) は従来どおり `rendered_prompt` をそのまま渡す。

## 3. 作業姿勢 (delegation/persona-context.ts)

協調コンテキストの姿勢節は 1 つだけ。 「通常の不明点で停止しない」。

- ファイル選択 / 命名 / 実装順序 / テスト粒度 / 既存実装の意図は、 コードと spec を根拠に自分で決める。
- 停止して質問してよいのは **外部権限が必要なとき** と **本当に不可逆な選択のとき** の 2 つだけ。
- それ以外は status 報告の detail / PR 本文へ書いて作業を完走させる。

## 4. 終了 (session-end)

completed / partial / failed の status 報告まで終えたら、 委託先は **その場で session-end** する。

- 待機して次の指示を待たない。 別タスクを自分で探して着手しない。
- 追加でやるべきことは `remaining` に書いて終了する (自分で始めない)。
- 順序は「commit → Revisor local PR → status 報告 → session-end」。

## 5. Memoria 追跡タスク

起票の位置は第 2 段階から**起動時 (prompt を書く直前)** へ移した。 link をその場で本文へ
載せるため。 冪等性は `delegation_runs.memoria_task_id` が担保する (未関連のときだけ書く)。
Memoria が落ちていても委託は止めない — 未起票の事実を本文へ書き、 完了報告に含めさせる。
キュー払い出し経路 (`executor.ts`) も同じく launch 結果から run へ焼く。
