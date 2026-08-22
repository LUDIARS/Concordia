---
task: project-code-registry
project: Concordia
kind: 実装
created: 2026-08-22
memory_links:
  - spec/feature/project-code-registry.md
---

# Cc project-code registry と登録コマンド

## 実装内容

- 静的 Markdown 読み込みを、初期登録ゼロの Cc SQLite registry に置き換える。
- 検証済み・冪等な登録 API と Discord command を追加する。
- session binding、title 推定、forum routing が registry を都度参照するようにする。
- project-code 登録を一貫して行う正式 Codex skill を用意する。

## 受け入れ条件

- 新規 DB に project code が自動登録されない。
- code と repository の同一登録は冪等で、競合する再利用は拒否される。
- command/API で追加した code が Cc 再起動なしで次の repository binding に使われる。
- 既存 `/projects` が静的ファイルではなく Cc registry の現在値を表示する。
- MakaiNui を `MN` として登録でき、専用 team rules injection の前提にできる。
