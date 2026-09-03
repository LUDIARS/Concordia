---
task: task-md-lane-due-keys
project: Concordia
kind: 設計相談
created: 2026-09-04
memory_links:
  - spec/feature/task-workflow.md
---
# task md frontmatter に `lane` / `due` キーを足す (人間の判断待ち)

## 状態: 着手しない

Actio `spec/feature/team-task/spec.md` **§11 (未決)** に
「task md の `lane` / `due` キー追加を task-workflow §2.1 の改訂として認めるか」が
人間の判断待ちとして挙がっている。

`task-workflow` §2.1 は Cc の task md frontmatter の正本なので、これを勝手に広げると
既存の task md を読む側 (reconciler / spawn / Revisor 連携) の契約が変わる。
判断が出る前に実装すると、認められなかった場合に巻き戻しになる。

## 判断が必要なこと

- `lane` / `due` を task-workflow §2.1 の正式キーとして認めるか。
- `lane` の許容値と意味、`due` の形式 (日付だけか日時か)・タイムゾーン・境界時刻を
  どう定義するか。
- 認める場合、既存 task md (キー無し) の扱い — 省略可とするか、移行を要求するか。

## 判断が出たあとの完了条件 (草案)

- `task-workflow.md` §2.1 に `lane` / `due` の許容値・形式・タイムゾーン・省略時の扱いが
  明記されている。
- frontmatter パーサが両キーを検証して読み、不正な値を黙って既定値へ丸めない。
- キーを持たない既存 task md が従来どおり読める。
- パース・既定値・後方互換の単体テストが green。
