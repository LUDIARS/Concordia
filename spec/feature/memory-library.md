---
type: feature
title: "Memory / Skill Library Hygiene"
description: "workspace 内の memory と skill を走査・レビューし、LLM 提案、dry-run 付き archive、台帳からの restore を提供する Library 機能。完全削除をせず、内容取得時の path traversal を拒否する。"
service: concordia
domain: governance
tags:
  - memory
  - skill
  - archive
  - restore
  - web
  - api
  - filesystem
status: implemented
updated: 2026-07-11
---

# Memory / Skill Library Hygiene

## 目的

Concordia が管理する workspace roots から memory / skill の source を走査し、重複・古さ・
index 不整合などのレビュー材料を Web UI と API に出す。整理操作は完全削除にせず、既定
dry-run の archive と台帳に基づく restore として提供する。

HTTP 境界は [`src/api/library.ts`](../../src/api/library.ts)、走査・review・archive の実装は
`@ludiars/memory`（[`lib/memory/src/`](../../lib/memory/src/)）。

実装責務は、root 解決
([`roots.ts`](../../lib/memory/src/roots.ts))、走査
([`scanner.ts`](../../lib/memory/src/scanner.ts))、形式 parse
([`parser.ts`](../../lib/memory/src/parser.ts))、決定的 review
([`heuristics.ts`](../../lib/memory/src/heuristics.ts))、LLM suggestion
([`analysis.ts`](../../lib/memory/src/analysis.ts))、内容 preview
([`content.ts`](../../lib/memory/src/content.ts))、archive / restore
([`archive.ts`](../../lib/memory/src/archive.ts)) に分かれる。

## 振る舞い

1. `resolveWorkspaceRoots()` から library roots を解決する。解決不能は
   `500 library_roots_unresolved` として fail-fast する。
2. source を走査し、LLM を使わない決定的 snapshot / review を作る。
3. 利用者は block または archived file の内容を preview できる。
4. `analyze` を明示した場合だけ `claude -p` の Haiku を呼び、矛盾検査と整理 suggestion を
   返す。suggestion は自動適用しない。`CONCORDIA_DISABLE_CLAUDE=1` では LLM を無効化する。
5. archive は既定 dry-run。`apply:true` のときだけ file/directory を sibling `_archive/` へ
   move し、memory index から対象 link を外し、機械台帳 `ledger.jsonl` と人間向け
   `ARCHIVE.md` へ記録する。
6. restore は台帳の `blockId` を使い、衝突がなければ元 path へ戻し、memory の index 行も
   復元する。

archive 先に同名 entry がある、移動対象と index 行の両方が無い、restore 先が既に存在する
などの衝突は上書きせず warning を返す。別 device の move は rename 失敗 `EXDEV` に限り
copy + remove へ fallback する。

## API

mount path は `/v1/library`。

| メソッド | path | 契約 |
|---|---|---|
| GET | `/` | snapshot と決定的 review。`?source=<id>` で source を絞る |
| GET | `/content` | `source` と `path` 必須。`archived=1|true` で archive 側を読む |
| GET | `/archived` | `source` 必須。台帳の現行 archived entries を新しい順で返す |
| POST | `/analyze` | `{ home }`。選択 source を Haiku で解析し suggestion を返す |
| POST | `/archive` | `{ blocks:[{sourceId,name}], apply?, reason? }`。既定は plan のみ |
| POST | `/restore` | `{ blocks:[{sourceId,blockId}] }`。entry ごとの結果を返す |

content 読み出しは source root または `_archive/` の包含を確認し、path traversal を拒否する。
directory skill は配下の `SKILL.md` を読む。返却 content は最大 200,000 文字で、超過時は
`truncated:true` と元の `size_bytes` を返す。

## 制約

- snapshot / review と archive plan は決定的だが、LLM `analyze` の文章は決定的ではない。
- archive は block 単位の逐次処理で、複数 block 全体の filesystem transaction ではない。
  各 item の `ok` と warnings を確認する。
- 壊れた `ledger.jsonl` 行は一覧時に best-effort で無視する。

## 関連

- [setup/config-reference.md](../setup/config-reference.md)
- [test/test-design.md](../test/test-design.md)
