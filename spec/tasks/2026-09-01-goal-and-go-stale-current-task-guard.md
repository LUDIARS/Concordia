---
task: "goal-and-go-stale-current-task-guard"
project: "Concordia"
kind: "実装"
created: "2026-09-01"
status: "pending"
---
# Goal & Go の stale current_task 再検証

## 目的

完了済みまたは削除済みの task md を、Goal & Go が現在タスクとして継続プロンプトへ提示し続けないようにする。

## 症状

`taskflow.continue_requested` が保存した `spec/tasks/*.md` を含む current_task が、対象ファイルの削除や完了後にもそのまま送信される。

## 原因

継続プロンプトの組み立て時に current_task の task md の存在と状態を再確認していない。

## 対策

固定書式から単一の task md 相対パスを抽出し、読み取り時に pending 状態を確認する。存在しない、または pending 以外なら current_task を消去してイベントを記録し、通常の残作業再計算へ委ねる。一時的な読み取り失敗では現在タスクを保持し、非同期の確認結果は同じ active session の同じ current_task にだけ適用する。

## 完了条件

- 削除済みまたは pending 以外の task md は継続プロンプトに含まれない。
- pending の task md と固定書式以外の current_task は従来どおり扱われる。
- 一時的な読み取り失敗や、確認中のタスク切り替えでは新しい current_task を消去しない。
