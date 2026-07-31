---
type: feature
title: "マニュアルページ統合と WebUI ページ整理"
description: "「AI に注入する自然文」の設定 (ハーネスルール / kind 別 Inject マニュアル) を WebUI のマニュアルページへタブで集約し、ハーネスルールを 1 件ずつ詳細編集できるようにする。併せて実運用されていない Chat / Rules ページをナビとルートから外し (backend は無変更)、社員ページを追加したナビ順を定義する。"
service: concordia
domain: http-interface
tags:
  - webui
  - react
  - typescript
  - navigation
status: implemented
owner: Concordia
related:
  - staff-roster.md
  - subsidiary-delegation.md
  - pr-queue.md
  - ../tasks/inject-manuals.md
updated: 2026-07-30
---

# マニュアルページ統合と WebUI ページ整理

## 1. マニュアルページ (`/manuals`)

「AI に注入する自然文」の設定を 1 ページに集約する。 運用中に一番よく触る設定が
子会社ページと マニュアルページに分散していたため、 タブで並べて詳細編集できるようにした。

| タブ | 対象 | 出典 |
| --- | --- | --- |
| ハーネスルール | `harness_rules` (allow / block ポリシー) | 旧「子会社」ページの `HarnessRulesSection` から移設 |
| Inject マニュアル | `inject_manuals` (kind 別の作業マニュアル) | 旧マニュアルページそのまま |

### ハーネスルールの詳細編集

1 件ごとに **kind / タイトル / 本文 / 並び順 / 有効無効**を直接編集して保存する
(旧 UI は追加・有効無効・削除のみで、 既存ルールの本文を直せなかった)。

- 並び順 (`sort_order`) が小さいものからガードプロンプトに並ぶ。
- builtin (既定) ルールは本文の調整と無効化は可、 削除は不可 (`builtin_cannot_delete`)。
- 実装: `web/src/pages/manuals/HarnessRulesPanel.tsx`。 API は既存の `/v1/harness-rules`
  (追加した API は無い)。

### Inject マニュアル

kind 語彙は固定 (設計相談 / 実装 / レビュー / テスト / 雑用)。 kind ごとに
「どういうテンプレのときに差し込まれるか」の条件を UI 上に明示した。
実装: `web/src/pages/manuals/InjectManualsPanel.tsx`。

子会社ページには「ハーネスルールの編集はマニュアルページへ移動しました」の案内リンクを残し、
ハーネス監査ログ (`HarnessAuditSection`) と子会社管理はそのまま残す。

## 2. ナビゲーションから削除したページ

| ページ | 措置 | 理由 |
| --- | --- | --- |
| Chat (`/chat`) | ルート + ページ削除 | 会話の実体は Discord / Slack 側。 WebUI の閲覧複製は使われていない |
| Rules (`/rules`) | ルート + ページ削除 | 内蔵 rule engine の GUI。 運用は Concordia 側の cron / delegation に寄っている |

いずれも**フロントの削除のみ**で、 backend (`src/rules/*`、 chat 関連 API、 Discord ingress)
は無変更。 rule engine は動き続け、 `/v1/rules` も生きている。 再度 UI が必要になったら
ページを足し直せる。

## 3. 追加したページ

| ページ | 内容 |
| --- | --- |
| 社員 (`/staff`) | 役職権限登録リスト。 `spec/feature/staff-roster.md` |

## 4. ナビ順 (2026-07-30 時点)

Monitor / Work / Taskflow / PRs / Cost / Reports / 作業ログ / Skills / 整理 / 記憶整理 /
Delegation / マニュアル / 社員 / 子会社 / 拠点 / Setup / 設定

モバイルは `Nav.tsx` の「使用頻度 top4 + ⋯More」方式のまま (変更なし)。
