---
type: feature
title: 人間の応答がない確認ループを止める
service: concordia
domain:
  - session-coordination
  - autonomous-continuation
  - blackbox-decision
  - taskflow-instructions
---

# 人間の応答がない確認ループを止める

> 所属ドメイン: [`session-coordination`](../domains/session-coordination.domain.json) · [`autonomous-continuation`](../domains/autonomous-continuation.domain.json) · [`blackbox-decision`](../domains/blackbox-decision.domain.json) · [`taskflow-instructions`](../domains/taskflow-instructions.domain.json)

`UX-CC-W4` と `CC-INV-08` に従い、人間待ちの確認は一度送ったら、確認可能な人間の応答まで
繰り返さない。確認停止はセッションの終了や許可の代行を意味しない。

## 状態所有者と再開条件

セッション所有の `sessions.metadata.human_response_confirmation` が、確認送付後の待機を
永続化する。残作業の再分解・自走無効時の次タスク確認・停止セッションの自動確認が共有する。
送付前に同期的に確保し、同時実行・AIの返答・Cc再起動で二重送付しない。

再開は Discord/Slack の人間 source を持つ入力、人間の actor を持つ reaction、質問カードの
回答、明示的な `user_activity` イベントで許可する。transcript の更新や user role だけでは
自動注入と区別できないため解除しない。端末側の再開通知は `user_activity` を使用する。
再開は次の通常判定を許可するだけで、即時に確認や作業を注入しない。

### 親セッションからの中継 (provenance の正規形式)

親セッションが人間の回答を子セッションへ中継するときは、`POST /v1/sessions/<子>/inject` の `source` を次の形式にする。

- `relay-human:<親 session id>` または `relay-human:<親 session id>:<回答者の表示名>`

この形式の inject は人間の応答として確認を解く (`parseRelayHumanSource`)。自由形式の source (例 `neco (親 lictor-24e68c85 経由)`) は自動注入と区別できないため解かない。Discord/Slack の発言者 ID が分かる中継は、従来どおり `discord:<uid>:…` / `slack:<uid>:…` をそのまま渡してよい。

### 観測された動きによる解除 (2026-11-17 追加)

確認後に作業を再開したのに、上の経路を通らなかったセッションが人間待ちのまま残らないよう、管制の巡回がそのセッション自身の動きを観測して解く (`src/control/human-response-activity-release.ts`)。

- 確保時に `human_response_confirmation_at` (確認の時刻) を記録し、前の周期の基準 (`human_response_confirmation_baseline`) を消す。
- 確認後のコミット (HEAD のコミット時刻が確認の時刻より新しい) があれば解く。
- 確認の時刻が無い旧データや、確認の時点ですでにあった状態は、最初の観測を基準 (HEAD・そのセッションの審査中 PR の `<number>:<headSha>`) として残し、以後 HEAD が変わる・基準に無い PR (提出・head の更新) が現れたら解く。PR が一覧から消えること (自動マージなど) は数えない。
- AI の発言・自動 inject・Revisor の通知・transcript の更新は動きに数えない (上の再開条件と同じ理由)。観測できなかった項目は比べない。
- 解いたときは `human_response_confirmation_released` に時刻・`observed_activity`・理由を残し、管制のログに出す。

## 残作業と停止確認

- 未回答質問で確認が抑止された場合、分解プロンプトも phase handoff も送らない。
- 残作業を尋ねた後にAIが「タスク無し」「待機します」と返しても再分解を送らない。
- 抑止結果は `waiting` として扱い、残作業なしという終了許可へ変換しない。
- 登録済み pending task を明示的に有効な goal-and-go で進める経路は、この確認待ちと区別する。
- `residual_checked` の `none` は新しい作業指示ではないため phase handoff を注入しない。
- 停止確認後の assistant/tool 出力、Revisor通知、phase handoff は人間の反応ではない。

## 検証

無応答・AIのみの応答・自動注入では1回に留まること、再起動後も保持されること、人間の入力で
次の1回が許可されること、セッション終了を発火しないことを確認対象とする。正規形式の中継 inject で解け自由形式では解けないこと、確認後のコミット・PR の提出/更新で解け PR の消失や観測不能では解けないことも確認対象とする。テスト・起動は
ユーザーの明示許可がある工程だけで実行する。
