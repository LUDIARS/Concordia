---
task: document-attachment-policy
project: Concordia
kind: 実装
created: 2026-09-07
memory_links:
  - spec/setup/spawn.md
---
# 資料共有時のattachment添付を共通injectへ追加する

## 目的
ユーザーがDiscordで資料を直接受け取れるよう、セッション共通の作業ポリシーに添付方針を含める。

## 完了条件
- 新規セッション向けの共通injectに、資料はファイルをattachmentとして添付する方針を追加する。
- Discord向けの既存sidecar経路とattachment_pathsを案内する。
- 送信権限・共有範囲の制限を維持し、送信失敗を添付済みと報告しない。
- 既存セッションへの再injectやサービス再起動は勝手に行わない。

## スコープ (編集可ディレクトリ)
- src/control/session-work-policy.ts
- spec/setup/spawn.md
