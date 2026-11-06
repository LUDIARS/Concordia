---
id: CC-PERIODIC-PROGRESS
type: feature
title: 委託・明示ゴールの10分進捗報告
service: concordia
domain: autonomous-continuation
status: draft
---

# 委託・明示ゴールの10分進捗報告

Actio: `actio:6f195c99-35a4-4548-a987-f172a59fbc01`。
価値 UX-CC-W2/W4/W5、シナリオ UX-CC-S2/S3/S5、
不変条件 CC-INV-01/03/04/05/06/08 を対象とする。LLM作成のdraftであり人間評価は未実施。

## 境界と業務用語

既存 `autonomous-continuation` に定期連絡の対象・間隔・継続上限判定を置く。
`agent-delegation` は live run の同一性と終端 status を所有し、bootstrap が読み取りで接続する。
コアの session-coordination / agent-delegation を支える下位責務であり、新しいコアを作らない。

- 対象依頼: 現在の子セッションに対応する launching/spawned/running run、または明示登録された
  complete/scoped goal。既定の complete モード、watch goal、古い metadata の run ID は対象根拠にしない。
- 概算進捗: 担当者が依頼全体の完了条件と成果の証拠から示す割合。Cc は時間や活動量から算出しない。
  判断できない割合は未確認と報告する。
- 報告要求: 同じ担当セッションへの inject。実報告の配達済みという証拠ではない。
  担当の通常の応答は既存セッション中継経路で依頼者へ届ける。その中継の送信失敗は未配達のままとする。
- 完了範囲: 依頼で定めた到達点。必要な審査・反映が残る依頼は100%にしない。
  提出で停止する依頼にはマージを追加しない。100%から新規作業を作らない。

## 巡回と停止

独立timerは追加せず、既存 stalled-session-nudge の10分tick（設定 `stall_nudge_interval_ms`）を使う。
対象依頼では idle 閾値だけを外し、最新活動がある稼働中にも報告を求める。
活動時刻不明・未応答の要求には要求を積み重ねない。対象でないセッションのidle判定は維持する。
busy resident はlive runがある場合だけ対象になり、idle residentは既存 gate で除外する。

未回答質問（取得不能を含む）・ask・human-wait・人間応答永続gate・自動確認OFF・3アウト・
Goal & Go OFF/停止/回数/時間上限・予算中断を維持する。既存の上限を定期連絡でリセットしない。
送信直前にsessionのactive状態、repo/origin/branch/project/task/会社と対象run/goalを再照合する。

進捗要求と委託watchdogの通常確認は、session所有の `cc_nudge_delivery` の時刻と活動watermarkを共有する。
同じ10分枠は同期的に1回だけ確保し、AI活動があっても枠内の再送を防ぐ。
watchdogが先行した場合にも同じ概算進捗の文面を含める。未着手プロンプト復旧や親への障害通知は別責務。
idle-nudgeは人間への既存の停止通知のみで、割合の報告や作業再開を生成しない。

未完了で人間判断待ちがなく実行可能な許可済み残件があれば、列挙だけで止めず続ける。
審査/委託通知待ちはポーリング・重複提出・再送・human-waitへの分類変更で埋めない。
同じ依頼の独立残件だけを進め、全件待機なら理由を示して新情報を待つ。
進捗要求は completed/failed/partial API を呼ばず、runの終端状態を変更しない。

## 回復と検証

要求枠はmetadataに保存するためCc再起動後も同じ枠を再取得しない。結果不明の配達を
成功とせず、次の新しい活動と期限経過で再評価する。frame更新は完了証拠でも人間回答でもない。
停止時は既存supervised interval所有者がtimerを解放する。

契約は実装前に宣言した `periodic-progress-C-1/C-2`。回帰対象は活動中のtick、対象限定、
新run/goalとbinding変更、質問/ask/待機/停止/上限/予算、watchdogとtickの両順序、
再起動後の枠保持、未応答抑止、報告文面と終端statusの分離。
テストコードと型チェックを用意し、実行は明示許可に従う。実機・人間評価を代替しない。
