---
type: feature
title: "自走継続 — 朝タスク仕分け + 停止セッション nudge"
description: "朝タスクを確認系/実装系に仕分けして自動処理する morning-tasks delegation テンプレと、transcript mtime を基準に応答が止まったセッションへ続行を促す stalled-session-nudge watcher の 2 機構を定義する。質問待ち除外・cooldown・fire-and-forget inject など運用上の安全策も規定。"
service: concordia
domain:
  - autonomous-continuation
  - session-coordination
tags:
  - typescript
  - lifecycle
  - delegation
  - state-machine
  - injection
  - polling
  - resume
  - monitoring
status: implemented
updated: 2026-10-09
---


# 自走継続 — 朝タスク仕分け + 停止セッション nudge

ユーザ指示 (2026-06-23) に基づく 2 つの自走支援機構。 共通の原則:

> **確認系 (人間がやる) タスクは整理して提示するだけ。 実装系 (AI がやれる) タスクは
> 残作業がなくなるまで実装する。 人間の判断が必要になったら ask で止める。**

「止まっている」 の定義 = **transcript が設定された idle 閾値以上更新されていない** こと。

---

## 1. 朝タスクの仕分け処理 (`morning-tasks` delegation テンプレ)

`src/delegation/seed.ts` の `morning-tasks` テンプレ。 `MorningScheduler` が毎朝 8 時に
今日期限の Memoria タスクを取得して invoke する (起動経路は従来通り)。

旧仕様: 「AI 実行可能なものを最大 3 件だけ自動処理、 人間タスクはスキップ」。

新仕様:
- 全タスクを **確認系 (人間がやる)** / **実装系 (AI がやれる)** に仕分ける。
  迷うものは確認系 (人間側) に寄せる。
- **確認系** (実機確認 / ブラウザ操作 / 外部サービス設定 / データ手入力 / 物理操作 /
  対人 / 本人判断) → **実行しない**。 「今日 人間がやること」 として整理して提示。
- **実装系** (コード修正 / CLI / PR / 設定変更 / ステータス更新 / 調査) →
  **残作業がなくなるまで実装** (件数上限なし)。
- 人間の判断が要る点が出たら決め打ちせず **ask で質問して保留** (進行を止める)。
- 最後にサマリ (① 人間がやること / ② AI が実装したもの / ③ 判断待ちで止めたもの) を
  投稿して `/session-end`。

---

## 2. 停止セッションの続行 nudge (`src/control/stalled-session-nudge.ts`)

全 active セッションを周期走査し、 **設定された idle 閾値以上応答が無い** ものに「残作業を確認して続行 /
判断が要るなら ask で停止」 を `session.inject` で流し込む watcher。

### idle 判定は transcript mtime
`last_seen_at` は WS ハートビート由来で「プロセス生存」 signal にすぎず idle を表さない。
**transcript ファイルの mtime** を「最後に応答した時刻」 として使う。

### ask 待ちは除外
意図的に人間判断を仰いで止まっているセッションは nudge 対象から外す — 「続行しろ」 と
被せると人間の判断停止を踏み潰すため。待ち判定には次の 2 signal を使う。

- 最後の assistant メッセージにある ```ask フェンス。ask の後に user 回答が来ていれば
  「回答済み」とみなす。判定は `isAwaitingHumanInput()` (純関数、transcript 末尾 64KB
  のみ読む)。
- `discord_pending_questions` に残る未回答の質問カード。AskUserQuestion 由来のカードは
  transcript に ask フェンスを残さないため、DB の未回答行を正本として先に確認する。

質問カード状態を照会できない場合は安全側でそのセッションを除外し、他セッションの走査は
続ける。

### cooldown
一度 nudge したら `cooldownSec` (既定 = idleSec) は再 nudge しない (per-session の
in-memory タイムスタンプで抑止)。 消えた session の記録は毎周掃除する。cooldown 経過後も、
前回 nudge 以降 transcript が更新されていなければ「前回確認に無反応」とみなし、再確認を
送らない。さらに [人間応答待ちの確認制御](human-response-confirmation.md) の永続状態により、
人間の反応がない間は assistant/tool が動いても再確認しない。

Cc 再起動で in-memory 記録が失われた場合も、Claude Code / Codex CLI 双方の transcript
末尾が `[自動確認]` で始まる user メッセージのままなら、未応答の nudge と判定して再送を
抑止する。後続の assistant 応答や tool activity は transcript 側の未応答判定を解除しても、
人間応答の永続 gate を解除しない。

### 3 アウト (`src/control/auto-confirm-strikes.ts`)
自動確認はセッションが返答するたびに再開できるため、通知待ちのセッションと「確認 → 返答 → 確認」を
繰り返してしまう (2026-10-05 neco 指示「確認処理がループする。人間の反応が無ければ待機すること」)。
人間の反応が無いまま連続 3 回自動確認を送ったら、以後はセッションが返答していても送らない。
ただし AI が進められる作業が残っている状態は例外 (下の「AI が進められる作業の継続誘導」)。

- 回数はセッション metadata `cc_auto_confirm_strikes` に置き、Cc 再起動をまたいで保持する。
- 3 回目の本文に「これ以降、人間の入力があるまで自動確認を送りません」と停止予告を添える。
- 回数を 0 に戻すのは来歴の確かな人間の入力だけ (`question.answered`、依頼者付きの `session.inject`)。
  判定は [人間応答待ちの確認制御](human-response-confirmation.md) の `humanResponseSession` と共通。
  自動確認や AI 自身の返答・審査や委託の進行では戻さない。

### AI が進められる作業の継続誘導 (CC-HUMAN-TODO-02)
2026-10-08 neco 指示「AIが実装中のものは、引き続き状況と残作業確認して処理を進めるよう自動確認で誘導」。

- 作業状態 (`selectSessionFollowupState`) が `task-active` / `review-needed` / `review-failed` /
  `merge-confirmation` / `reflection-needed` のときは、3 アウト済みでも自動確認を送る。
  本文の末尾に「状況と残作業を確認し、許可済みの範囲で処理を進める。人間の判断・回答が要る点は
  human-wait か ask で待機する」を添える。この送信は 3 アウトの回数に数えない。
- `review-wait` / `delegation-wait` / `task-blocked` / `unknown` と、作業状態を取得できない場合は
  従来どおり 3 アウトで止める (通知待ちへ確認を続けると往復に戻るため)。
- human-wait・未回答の質問カード・ask 待ち・人間応答待ちの永続 gate・「前回の確認に無反応」の
  抑止は、作業状態に関係なくそのまま効く。継続誘導は新しい実行許可ではない。

### 人間のやることの報告 (CC-HUMAN-TODO-01)
2026-10-08 neco 指示「自動確認時に人間のやることが残ってればメンションつけて報告。ピン留めもする。
前回の自動確認から人間のやることに動きがなければ通知はしない (自動確認は止めない)」。

- 巡回は毎周、auto_check が off の部署と常駐セッションを除く全 active セッションについて、
  人間のやることを照合する。idle・cooldown・3 アウト・人間待ちによる AI への確認の抑止とは独立。
- 集約対象と正本 (新しい正本は作らない):

| 種別 | 正本 |
|---|---|
| 判断待ち | session metadata `cc_human_wait` (`POST /v1/sessions/:id/human-wait`) の summary と Actio 参照 |
| 未回答の質問 | `discord_pending_questions` の未回答・未クローズ行 |

- 項目の種別・本文・参照から要約値 (sha256) を作り、session metadata `cc_human_todo_report` に
  報告済みの値として残す。時刻は要約値に含めない。
  - 初回、または前回の値と違う → セッション thread へメンション付きで一覧を投稿し、ピン留めする。
    前回の報告のピンは外す (`discord_human_todo_pin`)。
  - 前回と同じ → 人間向けの通知は出さない。
  - 項目が無くなった → メンション無しで解消を 1 回知らせ、ピンを外し、記録を消す。
- 記録は配信前に同期で行い (巡回が重なっても二重投稿しない)、送信に失敗したら同じ値の記録だけを
  戻して次の巡回で再送する。
- メンション先は管理画面の通知先 (`resolveMentionUserId`)、未設定ならセッションの依頼者。
  本文には人や AI の書いた文が入るので、`allowedMentions` でその 1 人に絞る。
- [承認インボックス](approval-inbox.md) の再訪通知は「人間が戻ったとき」に出す別の面で、
  こちらは自動確認の巡回で内容の変化を知らせる面。どちらも既存の正本を読むだけで、回答・解決は
  既存の経路で行う。

### nudge 本文
全 provider 共通の自然言語: ①未完があれば範囲を小さくして再実装 ②判断が要れば ask で
停止 ③これは終了指示ではなく、残作業が無い場合も自発的に `/session-end` せず、人間へ
終了可否を質問して待機する。

### 設定 (env)
- `CONCORDIA_STALL_NUDGE_ENABLED` (既定 `1`)
- `CONCORDIA_STALL_NUDGE_INTERVAL_MS` (既定 `600000` = 10 分)
- `CONCORDIA_STALL_IDLE_SEC` (既定 `600` = 10 分)
- `CONCORDIA_STALL_NUDGE_COOLDOWN_SEC` (既定 `CONCORDIA_STALL_IDLE_SEC` と同じ)

idle 閾値は巡回間隔と同じ 10 分に揃える (2026-08-09 neco 指示)。 「ゴールへ進んでいない
セッションを 10 分ごとに確認する」が成立するのはこの組み合わせのときだけで、 従来の 1 時間では
止まったセッションを丸 1 時間放置してから初めて声をかけていた。cooldown も同じ 10 分だが、
無反応のセッションへ確認を積み重ねることはなく、人間の反応後に再停止した場合のみ最短 10 分間隔で
再確認する (2026-08-27 neco 指示)。

fire-and-forget: WS 未接続なら inject は silent drop。 status 変更は行わない。
