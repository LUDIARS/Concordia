---
title: "Implementation tool fast paths"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-06
---

# Implementation tool fast paths

通常の会話・調査セッションには適用せず、実装作業の反復処理だけを複合toolへまとめる。
一つのsessionが複数実装を持てるため、新しいsession-level状態機械は作らない。

## Tasks

- [x] cwd から git repository / origin / checkout branch / project code を自動解決する。
- [x] project claim と Cc session binding を一つの begin 操作にまとめる。
- [x] 新規状態を作らず、既存session/testing claims/Revisor PRを正本にする。
- [x] Excubitor 操作を testing claim / control / release の一遷移にまとめる。
- [x] Revisor の初回提出と terminal PR の再審査を同じ submit 操作にまとめる。
- [x] Revisor通知を維持し、agent側のpollingを不要にする。
- [x] Lictor CLI から session id、project code、Cc / Ex / Rv endpoint を手組みせず操作できるようにする。
- [x] 通常セッションへ自動介入しない実装tool境界を仕様・APIで固定する。

## Non-goals

- 通常の会話、調査、相談、判断セッションの行動を制約しない。
- session 自身による test、service restart、merge、push を自動許可しない。
- endpoint や project code の複製表を Lictor に持たせない。
