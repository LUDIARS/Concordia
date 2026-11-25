---
type: feature
title: "Grok CLI のハーネスフック"
service: concordia
domain: hook-transport
status: draft
updated: 2026-11-25
---

# Grok CLI のハーネスフック {#CC-GROK-HOOK}

関連タスク `actio:fad4458d-32f8-4fee-89ca-f94b9c0043c5`。UX-CC-W1 / UX-CC-S1、CC-INV-01。

Grok CLI の利用者が作業を始めると、Grok のシェル・編集ツールにも Concordia の共通ハーネスが適用される。フック変換と判定への中継は hook-transport が担当し、許可の判定は既存の supervisor、セッション行とプランは既存の session-lifecycle が所有する。

- GHK-01 `PreToolUse` はシェル・編集ツールを Claude 互換の名前・引数に正規化して supervisor に渡す。成功時は無出力、拒否・構成不備・入力不正・異常終了時は `{"decision":"deny","reason":"…"}` を返す。
- GHK-02 `PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit` は既存の観測経路に `grok-cli` として送る。編集観測は成功したファイル操作に対応する。
- GHK-03 camelCase と snake_case の入力を受け付ける。ツール名と引数の変換は `tools/grok-hook-mapping.mjs` が担う。未対応のツール名は観測に保持する。

`tools/grok-hooks.example.json` を対象プロジェクトの `.grok/hooks/concordia.json` に配置し、コマンドにある runtime と config を実環境の絶対パスに合わせる。環境変数 `CONCORDIA_HARNESS_RUNTIME` と `CONCORDIA_HARNESS_CONFIG` でも指定できる。構成エラー時はパスを修正してから再試行する。登録を取り消す場合は配置した設定ファイルを取り除く。

Grok CLI 1.0.92 のフック形状は依頼に添付された実機情報に基づく。この実装をインストールしての実機評価は未実施。
