---
type: feature
title: "Cc 依存サービス診断コマンド"
description: "Anatomia、Augur、Memoria、Actio、Revisor の Excubitor 設定と稼働・接続状態を Discord から一括確認する。"
service: concordia
domain: runtime-orchestration
tags:
  - discord
  - excubitor
  - readiness
status: implemented
owner: Concordia
updated: 2026-08-24
---

# Cc 依存サービス診断コマンド

## コマンド

`/co-doctor` は Excubitor catalog を正本として Anatomia、Augur、Memoria、Actio、Revisor の
登録有無を確認し、登録された service code ごとに Excubitor の状態と liveness 履歴を読む。
ポートや endpoint は Concordia にハードコードしない。

Revisor は catalog に加えて workflow token の設定も確認する。Memoria は移行互換のため
`memoria-server`、`memoria` の順で catalog code を解決する。

## 判定

- Anatomia、Memoria、Revisor は稼働・接続必須。未登録、停止、liveness 不良は `NG`。
- Augur daemon と Actio adapter は optional。登録済みで停止中なら `WARN`、未登録なら設定不足として `NG`。
- Excubitor 自体へ接続できなければ個別状態を推測せず、Excubitor の `NG` を返す。
- 診断は read-only であり、サービスの起動・再起動は行わない。

## 関連するセッション操作

- `/co-go-and-go [state:on|off]`: Goal & Go の表示・切替。
- `/co-mode target:<plan|vibes> [reason]`: Plan/Vibes ルールの切替。Plan から Vibes は既存の承認を維持する。
