---
type: feature
title: "Session log browser"
description: "workspace の session-logs Markdown を1ファイル1セッションとして読み、日付順一覧、project facet、全文検索、本文詳細を Web/API へ提供する読み取り専用機能。"
service: concordia
domain: session-coordination
tags:
  - session-log
  - handoff
  - markdown
  - search
  - web
  - api
status: implemented
updated: 2026-07-11
---

# Session log browser

## 目的

`/session-end` と handoff workflow が作る過去の作業記録を、プロジェクト別・全文 query で
探し、1 セッションの Markdown 本文まで読めるようにする。reader は読み取り専用で、
session log の生成・編集・削除を行わない。

API は [`src/api/session-logs.ts`](../../src/api/session-logs.ts)、Markdown reader は
[`src/session-logs/reader.ts`](../../src/session-logs/reader.ts)。

## source 解決

1. `CONCORDIA_SESSION_LOGS_DIR` が非空なら、その path が存在するときだけ使う。
2. 未指定時は管理 workspace roots を順に調べ、最初に存在する `<root>/session-logs` を使う。
3. どこにも無い場合は設定エラーにせず、一覧を空として扱う。

対象は directory 直下の `*.md`。1 file を 1 session entry とし、filename stem を ID にする。
標準 ID は `YYYY-MM-DD` または `YYYY-MM-DD-N`。形式外の Markdown も一覧には含めるが、
`date` は空になる。

## 一覧 metadata

- `title`: 最初の H1。無ければ ID。
- `date` / `seq`: filename から抽出。
- `projects`: 本文全体を project dictionary と照合した正式名の配列。
- `sections`: H2 の先頭 40 件。
- `excerpt`: heading を除いた非空行を連結した先頭約 280 文字。
- `size_bytes` / `mtime`: filesystem metadata。

一覧は date descending、同日は seq descending、最後に mtime descending。

## API

mount path は `/v1/session-logs`。

| メソッド | path | 契約 |
|---|---|---|
| GET | `/` | `project`、`q`、`limit` で絞る一覧。limit 既定 200、範囲 1..1000 |
| GET | `/:id` | metadata と `content_md`。directory 無し / ID 不在は 404 |

一覧 response の `projects` facet は filter 前の全 entry から作るため、filter 中も安定する。
`q` は title、section、excerpt を連結した case-insensitive substring 検索。`total` は全件、
`total_matched` は limit 適用前の一致件数。

## 安全境界

詳細 ID は word/dot/hyphen だけを許し、`..` を拒否する。さらに解決後 path が
session-logs directory 配下であることを検証し、path traversal を許可しない。

## 制約

- 検索対象は title、H2、excerpt であり、280 文字以降の本文だけに現れる語は一覧 query で
  一致しないことがある。詳細 API は full Markdown を返す。
- 読めない file や directory entry は一覧時に skip する。
- 複数 workspace roots に session-logs がある場合も、最初に解決した 1 directory だけを読む。

## 関連

- [session compaction](./session-compaction.md)
- [service schema](../interface/service-schema.md)
- [setup/config-reference.md](../setup/config-reference.md)
