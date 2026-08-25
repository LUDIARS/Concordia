---
type: feature
title: "決定論終了と再キュー — タスクワーカー残留の根治"
description: "セッションの終了を LLM の善意任せにしない。completed + residual none で provider 別 session-end を再送可能に inject し、応答しなければ Cc が強制終了する。途中報告は status {completed|partial, remaining} で受け、残作業は同一セッションの延命ではなく新規ワンショット run として再キューする。未回答質問はプロセスと寿命を分離し、blocked 化してセッションを畳む。"
service: concordia
domain: session-coordination
tags:
  - lifecycle
  - taskflow
  - session-end
  - delegation
  - inquiry
  - safety
status: planned
related:
  - feature/goal-and-go.md
  - feature/task-workflow.md
  - feature/inquiry.md
  - feature/session-shutdown.md
  - feature/plan-gate.md
updated: 2026-08-25
---

# 決定論終了と再キュー

> 2026-08-13 neco 指示。 タスクワーカー / パートタイマーが残る理由は
> (1) タスクに続きがあるのに途中報告と継続指示が連携していない、
> (2) session-end が呼ばれていない、 の 2 件。 質問で止まることもある。
> 本 spec は「終わる」を決定論のバックストップで保証し、 「続き」を再キューに変える。

## 0. 原則

1. **終了の最終判断を LLM の従順さに依存しない。** inject は促しであり、 効かなければ
   Cc が既存 `endSession` で畳む。
2. **継続 = セッション延命ではなく新規 run の再キュー。** 状態は worktree・ブランチ・
   task md・契約が持つ。 プロセスは使い捨てにする。
3. **質問はプロセスより長生きしてよい。** 未回答 ask はセッションを生かし続ける理由に
   ならない。 blocked 化して畳み、 回答後に新しいワンショット run で再開する。

## 1. 即時バグ修正 (spec 実装に先行)

- **完了お伺いの生涯 1 回制限**: 完了時の人間判断待ちを撤去し、teardown ladder の
  `run_key` で同一runの二重終了を防ぐ。delegation は永続 run ID をキーに使うため、
  同名タスクが連続しても新しい ladder を予約できる。
- **goal-and-go 無効パートタイマーの無期限残留**: `shouldEndAutonomousTaskflow` が
  `goalAndGoEnabled` を要求するため、 opt-in していないパートタイマーは
  「閉じてよいか確認してください」の人間待ちメンションに落ちて残る。 → 終了条件が
  確定したら opt-in 有無に関わらず ladder を予約し、goal-and-go は次タスク自走だけを分ける。

## 2. 決定論終了 (teardown ladder)

completed 報告 (または completion 黒箱の検知) + residual `none`、再キューを起案済みの
`partial`、または ask detach により `blocked` 化した run で、以下を段階実行する:

```
t0     provider 別 session-end inject (既存 auto-session-end-inject。 exactly-once を
       「run 単位で once」に変更 = 再キュー後の次 run では再び送れる)
t0+5m  未終了なら同じ inject を 1 回目再送 (pending question blocker は現行どおり
       auto:session-end を止めない)
t0+10m 未終了なら同じ inject を 2 回目再送
t0+15m 依然 active なら Cc が endSession で強制終了 (spoken session-end と同じ経路)。
       `teardown_forced` イベントを監査記録
その後  session-shutdown spec (Lictor POST /v1/shutdown) により CLI・Lictor プロセスも
       1 分以内に消える。 reaper は最終保険として現行のまま残す
```

- 秒数は config: `CONCORDIA_TEARDOWN_RETRY_SEC` (300) / `CONCORDIA_TEARDOWN_FORCE_SEC` (900)。
- **inquiry.md §7 との整合**: 継続可否に人間判断が要る場合のお伺いは残す。PR open/draft +
  residual `none` は終了条件が機械的に確定しているため、お伺い対象に戻さず ladder が執行する。
- PR open/draft + residual `none` + 未回答質問なしで終了条件は確定済みとし、完了お伺いを
  挟まず **「session-end を実行せよ」 の確定指示**を ladder の t0 として送る。
- **session-shutdown spec (status: planned) の実装は本 spec の前提**であり、 実装リストに
  Lictor 側タスクとして含める (task md は Lictor リポに置く)。

## 3. 途中報告と再キュー

### 3.1 status API の拡張

`POST /v1/delegation/runs/:id/status` を拡張する:

```jsonc
{
  "status": "completed" | "partial",
  "remaining": [                       // partial 時必須 / completed 時は空
    { "title": "...", "note": "...", "scope_dirs": ["..."] }
  ],
  "acceptance_report": [               // plan 由来タスクは必須 (plan-gate §1)
    { "criterion": "...", "met": true, "note": "..." }
  ]
}
```

### 3.2 再キュー

- `partial` を受けたら: remaining を task md 化 (既存 task md があれば taskflow state の
  更新のみ) → **新規ワンショット run を起案** (契約・worktree/ブランチ・memory_links を
  引き継ぐ) → 報告したセッションは §2 の teardown ladder で畳む。
- goal-and-go の同一セッション継続 (`taskflow.continue_requested`) は残すが、 既定は
  再キューとする (契約フィールド `continuation: "requeue" | "in-session"`、 既定 requeue)。
  in-session を使う場合もフェーズ境界コンパクション (phase-compaction) を必ず挟む。
- `acceptance_report` に未達 (`met: false`) がある completed は residual 判定へ
  「未達条件」として渡し、 残作業扱いにする (勝手に完了で閉じない)。

## 4. 質問の非同期化

- パートタイマーの未回答 ask が `CONCORDIA_ASK_DETACH_SEC` (既定 1800) を超えたら:
  run を `blocked` にし、 質問カードはそのまま残して **セッションだけ teardown ladder で
  畳む**。 質問カードに「回答すると新しい run で再開します」を追記する。
- 回答が付いたら、 回答内容を初回指示 context に含めた新規ワンショット run を起案する
  (worktree・ブランチは blocked run のものを引き継ぐ)。
- 質問機会そのものの削減は plan-gate (設問フェーズへの前倒し) と persona-context 追記
  「前提が欠けたら質問せず『前提未確定』として PR 本文に明記して completed 報告」で行う。
  質問を許すのは権限・破壊的操作カテゴリのみ (inquiry の語彙を使う)。

## 5. 受け入れ基準

- [x] §1 の終了残留が修正され、パートタイマーは明示OFF・タスク数に関わらず、終了条件確定時に
      run単位の teardown ladder へ入る。
- [ ] completed + residual none のセッションが 15 分以内に必ず終了する (inject 無視でも
      強制終了が効き、 監査イベントが残る)。
- [ ] session-end 完走から 1 分以内に CLI と Lictor プロセスが消える (session-shutdown 連携)。
- [ ] partial 報告で remaining が task md / state に落ち、 新規 run が起案され、 報告元
      セッションは畳まれる。
- [ ] 未回答 ask が閾値を超えた run は blocked になりプロセスが消える。 回答で新規 run が
      起案され、 前の worktree/ブランチを引き継ぐ。
- [ ] acceptance_report の未達条件が residual に渡り、 未達のまま閉じない。
