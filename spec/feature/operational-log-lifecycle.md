---
type: feature
title: "Operational log lifecycle — bounded cc-live retention"
description: "Concordiaの運用ログを起動時に世代交代し、保持数と診断ノイズを制限する責務境界。"
service: concordia
domain: observability
tags:
  - logging
  - rotation
  - retention
status: implemented
related:
  - ./task-workflow.md
updated: 2026-08-02
---

# Operational log lifecycle — bounded cc-live retention

`src/shared/logger.ts` が file destination を開く前に、
`src/shared/log-file-rotation.ts` が対象サイズを確認する。既定は 128 MiB、保持は5世代で、
`CONCORDIA_LOG_FILE_MAX_MB` と `CONCORDIA_LOG_FILE_KEEP` により正の整数へ変更できる。

Windowsでは稼働中に pino の file descriptor が対象を保持するため、rotation は起動時だけ行う。
閾値以上なら timestamp 付きarchiveへ renameし、mtimeが新しい順に保持上限まで残す。
削除対象は `<stem>.YYYYMMDD-HHMMSS<ext>` に一致する自前のarchiveだけで、同じ prefix を持つ
無関係なファイル (lock等) や稼働中のログ本体には触れない。
stat・rename・archive削除に失敗してもログ出力自体は止めず、次回起動で再試行する。

`src/taskflow/md-store.ts` のtask parsing責務は task workflow に残す。observability が扱うのは
運用ログ量だけであり、次の重複ノイズを抑える。

- `.git` がdirectoryでないworktree/submoduleと、dot-prefixed複製directoryをscan対象外にする
- 同じpathのparse/read失敗は1回だけwarnし、正常化後に再発した場合だけ再度warnする
- `parseTaskMarkdown` 自身はlogを出さず、失敗理由を呼び元へ返すだけにする (抑制の迂回を防ぐ)

この境界はtaskの内容・状態遷移・永続化形式を変更しない。
