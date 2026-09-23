---
task: cc-hook-mcp-rollout-focus-verification
project: Concordia
kind: テスト
created: 2026-09-23
memory_links:
  - spec/feature/codex-hook-console-free.md
  - spec/feature/windows-console-focus-investigation.md
---
# Cc MCPフックを稼働設定へ反映しフォーカスを確認する

## 目的
検証済みMCP経路を実際のCodex設定へ反映し、ツール終了時のコンソール表示とフォーカス移動を観測する。

## 完了条件
- 現行hooks/configをバックアップし、既知のCc commandのみ移行する。
- MCP接続とCcの観測・復旧文脈の受信を確認する。
- ツール呼び出し前後のイベントログとフォーカスを照合する。SessionEndと他サービスのcommandが残る制約を区別する。
- 確認不能な項目を成功扱いせず、必要ならバックアップへ復旧する。

## スコープ (編集可ディレクトリ)
Concordia/tools、spec/feature。承認済み運用操作としてユーザーのCodex hooks.json/config.tomlと必要な再接続。
