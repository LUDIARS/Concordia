---
type: feature
title: "Cc 内蔵 Task と Actio 復旧同期"
service: concordia
domain: task-management
status: implemented
updated: 2026-08-24
---

# Cc 内蔵 Task と Actio 復旧同期

Actio が未登録・停止・接続不能でも、Cc は `POST /v1/tasks` で受けた Task を SQLite
`cc_tasks` に先に永続化して返す。Task は `GET /v1/tasks`、`GET /v1/tasks/:id`、
`PATCH /v1/tasks/:id` で参照・更新する。自動削除および clear API は持たず、完了は
`status=done`、取り消しは `status=cancelled` で表す。

入力は Memoria / Actio の単純 Task と揃え、title、details、status、kind、creator_type、
category、due_at を持つ。todo/doing は open/in_progress として受理する。`source_key` を
指定した作成は冪等で、既存行を返す。

task workflow が有効な間、Cc は Excubitor catalog から `actio` の実効 port を解決し、
`pluginId=concordia`、`pluginRef=<Cc task id>` で Actio と同期する。同期前には必ず
pluginRef を照合し、既存 Task があれば再利用する。Actio 不在時は `pending` のまま保持し、
復旧後に再試行する。POST の結果が不明な場合は `unknown` とし、照合で発見できるまで
POST を重ねない。同期済みでも Cc の Task は削除しない。
`unknown` の Task をローカル更新しても不明状態は維持し、照合できるまで再 POST しない。
