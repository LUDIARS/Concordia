---
type: feature
id: CC-HOOK-NO-CONSOLE
title: Codex Cc hook transport without per-event shells
status: draft
---

UX-CC-W4/W5: ツールを使っても利用者のフォーカスを奪わず、Ccの観測/復旧文脈を受け取れる。
状態所有者は既存Cc session/reliability API。CLIとMCPは同じhook関数を呼ぶadapter。
CC-HOOK-01: eventごとのenv/到達性/outputを隔離しsessionの状態を混ぜない。
CC-HOOK-02: disable、opt-in、active-session選択、HTTP payload、stdoutの意味を維持。
CC-HOOK-03: MCPイベントごとのPowerShell/cmdラッパーを起動しない。起動時とprompt時のgit参照はexecFileSync + windowsHideで直接実行。既存CLIを維持。
CC-HOOK-04: migrationはCc commandだけを対象にし、他者hook・matcher・timeoutを保持。

対応するSessionStart/UserPromptSubmit/PostToolUse/PreCompact/PostCompactのみMCPへ移行。
SessionEndはMCP非対応なのでcommandを残す。全起動の非表示保証とは報告しない。
追加MCP接続とhook信頼確認が必要。移行用候補設定を生成し、現行設定に無断適用しない。
復旧は元のcommand設定へ戻す。二重登録しない。
回帰: CLI/MCP出力互換、session選択、offline後の次event復旧、設定対象限定・再実行同値。

障害記録: main checkoutのspec/plan/problem_logs/2026-09-23-clipboard-mime-and-hook-focus.md。画像修正/窓問題の稼働確認は未実施。

## 移行候補と反映条件

- `codex-hook-console-free.hooks.json`: 現行設定のCc command 6件をMCPへ置換した候補。MemoriaとSessionEndを保持。
- `codex-hook-console-free.config.toml`: config.tomlへ追加するMCP登録。実行先は本体Concordia。worktree起動はしない。
- MCPへのCc環境変数転送を明示。session_idや秘密値を設定ファイルへ固定保存しない。
- 適用前に本体へコードを反映し、config.tomlへ既存設定と衝突しないよう追加する。その後接続・信頼確認が完了してからhooks候補を適用する。現時点ではいずれも未実施。
- SessionStartはMCP接続より先に走ると観測できない。Cc/Lictorの登録を正本とし、再起動後の初期policy注入・最初のpromptの観測を確認する。
- 復旧は変更前hooks.json/config.tomlを保存して戻す。候補を現行設定へ丸ごと上書きせず、適用時の差分を再照合する。
- Codex MCP hookは別hookを誘発しないため自己再帰しない（[公式仕様](https://learn.chatgpt.com/docs/hooks#execution-and-lifecycle)）。SessionEndのcommandと他サービスのhookは残るため、端末全体の窓消失は実機確認まで未確認。

## 検証状況

2026-09-23、neco「検証を実行」に基づき追加修正の回帰を実施。Cc claim/releaseは両試行ともHTTP 200で完了。サービス起動・再起動・設定適用は行っていない。

- Node test runner: 23件成功、exit 0。hook runtime/MCP wire契約/migration/internal-agent-hook。
- Vitest: 91件成功、exit 0。画像19、spawner40、selection API 3、settings 5、session-id20、policy4。
- Vitestのdelegation blockを別プロセスで実行: 1件成功、exit 0。
- 合計115件。execFile windowsHide:true、Node test isolationなし、Vitest threadsを使用。
- 初回はVitest用session-idテストをNode runnerへ渡してロードに失敗。正しいVitest runnerへ移して20件成功。
- 初回のVitest一括実行は72件のassertion成功後、exit 3221225477 (0xC0000005)で異常終了。成功扱いせず、DBを使うdelegation blockを別プロセスへ分けて再実行し全プロセスexit 0を確認。一括終了クラッシュの根本原因は未確定。
- 前回実施済み: JavaScript構文、source TypeScript noEmit、全差分Anatomia verify 5ゲート成功。今回コード変更なし。
- ユーザー設定は未適用。実際の貼り付け画像配送とWindowsフォーカス移動の運用確認は未実施。

再実行コマンド（作業worktree内、非表示プロセスで単体検証のみ）:

    node --test --test-isolation=none tools/concordia-hook-runtime.test.mjs tools/concordia-hook-mcp.test.mjs tools/concordia-hook-migration.test.mjs tools/internal-agent-hook.test.mjs
    node node_modules/vitest/vitest.mjs run src/discord/image-inbox.test.ts src/delegation/internal-agent-policy.test.ts src/api/internal-agent-selection.test.ts src/control/internal-agent-settings.test.ts src/control/spawner.test.ts tests/concordia-hook-session-id.test.mjs
    node node_modules/vitest/vitest.mjs run tests/blocks/agent-delegation/delegation-template.block.test.ts
