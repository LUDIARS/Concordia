---
title: 本社と子会社でデプロイ通知対象を分ける
status: draft
---

# 本社と子会社でデプロイ通知対象を分ける

## 目的

本社はすべてのデプロイ反映を受け、子会社は所属プロジェクトの Revisor Workflow に限って安全な宛先へ受け取れるようにする。

## 完了条件

- C-1 handleServiceDeployment(event): 同一 `(code,currentHash)` は配送しない。
- C-2 composeDeploymentNotice(input): Revisor 取得不能でも反映通知を作る。
- C-3 deliverDeploymentNotice(input): Discord bot 配送は mention を全無効化する。
- C-4 resolveDeploymentTargets(input): HQ は常時、子会社は scope と Revisor workflow の双方を満たすときだけ配送対象にする。
- 子会社通知先、workflow ミラー、管理 API/UI、仕様、回帰テストを対で更新する。
