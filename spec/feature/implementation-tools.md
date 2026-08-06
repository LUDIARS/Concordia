---
title: "Implementation tool fast paths"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-06
---

# Implementation tool fast paths

実装作業で繰り返す既存操作を、一回のtool requestへまとめる。単一セッションが複数実装を
並行して扱えるよう、session-levelのworkflow stageや新しい状態機械は持たない。

## State owners

- project/task/repo/branch binding: 既存 `sessions` 行
- service traffic: 既存 `service_test_claims`
- review: Revisor local PR
- notification: Revisorのsession inject

## API

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/v1/implementation-tools/bind` | `{session_id,cwd,task}` | gitを一度検査し、repo/origin/branch/project codeを解決してsession bindingを更新。 |
| POST | `/v1/implementation-tools/service` | `{session_id,service_code,action,note?}` | testing claim、Excubitor control、releaseを一要求で実行。 |
| POST | `/v1/implementation-tools/review` | `{session_id}` | local PRを提出。既存PRがfailed/action_requiredならretry。 |

## Efficiency rules

- project code表をLictorやagentへ複製せず、Ccのresolverをworkspace設定単位でcacheする。
- bind は設定済み workspace 内の実パスだけを受け付け、応答・event に absolute path / origin を複製しない。
- bindは`repo_path/current_task`を最新対象へ更新し、`active_repos`は上書きせず追加する。
- git root取得後のbranch/origin照会を並列化する。
- session idはLictor sidecarが付与し、利用者は取得しない。
- Cc/Ex/Rv endpointは既存clientが解決する。
- Exの事前detail GETは行わず、control API自身のcatalog検証へ一本化する。
- service claim競合時はcontrolせず、そのrequestのclaimを即releaseする。
- controlは成功・失敗を問わずfinallyでreleaseする。
- review statusのpollingやsession-level stageを追加しない。
- 通常の会話・調査セッションには自動介入しない。
