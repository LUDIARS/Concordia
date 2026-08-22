---
type: feature
title: "Project code registry — Cc 所有の空初期レジストリ"
service: concordia
domain: project-code-registry
status: implemented
updated: 2026-08-22
---

# Project code registry

Concordia が project code とローカル Git repository の対応を SQLite に保持する。
`LUDIARS/PROJECT-CODES.md` は人間向け略称表として残せるが、Cc の repository binding、
session title、forum routing の正本には使わない。

## 契約

- 新規 DB の registry は空で始まり、既存 Markdown 一覧を seed しない。
- code は大文字小文字を区別する。project、repo path、repo origin は重複登録しない。
- 登録時は configured workspace root 内の Git repository を検査し、canonical root と
  origin を Cc が確定する。入力された表示名や origin を信用しない。
- 同じ code と同じ repository の再登録は成功扱いにして、異なる対応への上書きは拒否する。
- API と Discord command から追加でき、追加直後の repository binding に再起動なしで効く。
- 自動削除・自動 import は行わない。

## 操作面

- `GET /v1/project-codes` — 登録一覧。
- `POST /v1/project-codes { code, repo_path, added_by? }` — 検証済み登録。
- `/project-code add code:<code> repo:<absolute-path>` — 管理職向け Discord command。
- `/project-code list` と `/projects` — 現在の DB 正本を表示。
