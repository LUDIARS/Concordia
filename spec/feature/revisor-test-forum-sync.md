---
title: "Revisor Test Workflow synchronization"
status: implemented
service: concordia
domain: release-coordination
updated: 2026-07-28
---

# Revisor Test Workflow synchronization

## Purpose

CcのDiscord Test Forumは、RevisorのローカルPR審査を通過した
`Open / Test OK` のプロダクトだけを掲載する。GitHub PR台帳は候補の正本にしない。

## Source and lifecycle

- CcはExcubitor catalogでRevisorの稼働ポートを解決し、
  `GET /v1/test-workflow` を読む。ポートは設定やソースへ固定しない。
- 読取はloopback限定でRevisor側がtokenを要求しないため、`CONCORDIA_REVISOR_WORKFLOW_TOKEN`
  は任意とする。設定されている場合だけBearerとして送る (未設定でも同期は動く)。
  設定する場合はsecret managerから注入し、Revisorのlocal workflow tokenと一致させ、
  PR-gate origin tokenとは混同しない。
- Revisorが返すrepository、local PR番号、タイトル、reviewed head SHAから
  Test Forum候補を作る。
- 同じrepository・PR番号・reviewed head SHAの投稿は維持する。
- reviewed head SHAが変わった場合は旧投稿を閉じ、現在の候補を新規投稿する。
- Revisor一覧から消えた候補は、merge・close・再審査などの理由を推測せず旧投稿を閉じる。
- Revisorへの接続または応答検証に失敗した場合は同期全体を失敗として扱い、
  既存投稿を一括で閉じない。

## Runtime boundary

Revisor Test Workflowの読取クライアントはDiscord表示処理から分離する。
接続は読取専用で、local workflow tokenが設定されている場合のみBearer送信する。
レスポンス形式が不正な場合は項目を黙って捨てずfail-fastする。
