---
task: reaper-node-only-classify
project: Concordia
kind: 実装
status: done
created: 2026-10-12T00:00:00.000Z
source_session: lictor-331515ae-3ce6-4d9f-9870-0f3ea8a9b1f3
memoria_task_id: null
pr_number: null
actio_task_id: 63563682-f261-44af-8e81-0c4647377a69
memory_links: []
---
# reaper が Windows Terminal を孤児 Lictor と誤認して稼働中セッションを落とす不具合を直す

Actio: `actio:63563682-f261-44af-8e81-0c4647377a69`
設計正本: `spec/feature/session-process-reaper.md` の SPEC-REAPER-SHELL-WRAPPER 節。

### 原因

`classifyKind` はコマンドラインに `lictor.mjs` を含むかの文字列一致で判定し、除外は shell
ラッパだけだった。Windows Terminal が開いていない状態で Cc が `wt new-tab ... cmd /c node ...lictor.mjs`
を実行すると WindowsTerminal.exe 自体がこの起動命令をコマンドラインに持ち、孤児 Lictor と判定されて
tree-kill され、同じウィンドウの稼働中セッションが全部落ちていた。

### 変更内容

- `src/control/agent-process-classify.ts`: 許可リスト方式に変更。コマンドラインの先頭トークン
  (引用符対応、`commandExecutable`) の basename が `node` / `node.exe` / `nodejs` の時だけ分類し、
  image 名が取れる場合はそれも node 系であることを必須にする。不要になった `SHELL_IMAGE_NAMES` を削除。
  `isShellWrapperCommand` はテストと reaper の再 export のため残す。冒頭コメントに経緯を追記。
- `reaper.ts` の `parseWindowsProcLine` / `parsePosixProcLine` は `classifyKind` 経由のため同じ判定が効く
  (テストで確認)。
- spec の SPEC-REAPER-SHELL-WRAPPER 節に許可リストと経緯を追記。
- `augur.contracts.json` に `reaper-node-only-C-1` 契約と述語モジュールを追加。

### 再利用探索

- 既存の `isShellWrapperCommand` を拡張して wt を足す案は不採用 (拒否リストは起動子が増えるたびに漏れる)。
- 実行ファイル名の抽出は既存に共通ヘルパーが無いため、分類モジュール内に `commandExecutable` を新設した。

### 検証

- `npx vitest run src/control/agent-process-classify.test.ts tests/reaper.test.ts` で 38 件すべて通過。
- `npx tsc --noEmit -p .` は exit 0。
- Augur の inject は既存関数のため applied=0 で、契約 C-1 は集計上 uncovered (not-injected)。

### 対象外

- `excubitor.catalog.yaml` の一時措置 `CONCORDIA_REAPER_ENABLED: "0"` には触れていない
  (マージ・反映後に人が判断する)。

## 完了条件

- C-1 classifyKind(cmd, imageName): 実行ファイル (先頭トークン、取れる場合は image 名) が node 系でなければ lictor / agent-client に分類しない
- WindowsTerminal.exe で始まり `lictor.mjs` 起動命令を含むコマンドラインは、image 名が無い場合も WindowsTerminal.exe / wt.exe / OpenConsole.exe の場合も null になる
- 既存ケース (LICTOR_BODY / AGENT_CLIENT / 引用符付き node.exe フルパス / POSIX `/usr/bin/node bin/lictor.mjs`) は従来どおり分類され、image 名 node.exe + Lictor 本体は lictor になる
- 対象テストファイルと typecheck が通る
