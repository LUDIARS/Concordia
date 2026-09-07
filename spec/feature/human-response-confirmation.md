---
type: feature
title: 人間の応答がない確認ループを止める
service: concordia
domain: session-coordination
---

# 人間の応答がない確認ループを止める

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

## 残作業と停止確認

- 未回答質問で確認が抑止された場合、分解プロンプトも phase handoff も送らない。
- 残作業を尋ねた後にAIが「タスク無し」「待機します」と返しても再分解を送らない。
- 抑止結果は `waiting` として扱い、残作業なしという終了許可へ変換しない。
- 登録済み pending task を明示的に有効な goal-and-go で進める経路は、この確認待ちと区別する。
- `residual_checked` の `none` は新しい作業指示ではないため phase handoff を注入しない。
- 停止確認後の assistant/tool 出力、Revisor通知、phase handoff は人間の反応ではない。

## 検証

無応答・AIのみの応答・自動注入では1回に留まること、再起動後も保持されること、人間の入力で
次の1回が許可されること、セッション終了を発火しないことを確認対象とする。テスト・起動は
ユーザーの明示許可がある工程だけで実行する。
