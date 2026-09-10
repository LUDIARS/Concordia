---
task: harness-client-installation
project: Concordia
kind: 雑用
created: 2026-09-10
memory_links:
  - spec/setup/harness-reliability.md
  - https://learn.chatgpt.com/docs/hooks
---
# クライアントへCcフックと定型手順を導入する

## 目的
実行クライアントの対応範囲に合わせて、圧縮・ツール結果・入力のフックと配布スキルを導入する。

## 完了条件
- 稼働Ccのsetup APIから設定を取得し、既存の無関係なフック・権限設定を保ってマージする。
- 常設コマンドは本体フォルダを参照し、一時worktreeへの参照を残さない。
- Pf未登録時の従来検索、Actio/Memoria作業管理、ハーネス復旧のスキルを配置する。
- Codexのフック定義レビューと信頼状態を確認する。信頼承認を迂回しない。
- 導入済みと実イベント観測済みを分け、読み戻しと適用範囲を記録する。

## スコープ (編集可ディレクトリ)
依頼対象workspaceのクライアントhook・skill配置先、およびCcの導入資料。個人の認証情報や無関係なMCP設定は変更しない。
