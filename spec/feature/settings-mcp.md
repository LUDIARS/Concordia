# Cc 設定の MCP 操作

状態: draft / 対象: configuration / UX: UX-CC-PRODUCT

利用者がチャットから設定値と出所を確認し、指定した項目だけ変更できる。
設定の状態所有者は既存 settings registry、チームの状態所有者は teams API。
MCP は HTTP adapter であり、新しい DB や設定の正本を持たない。

- CC-MCP-CONFIG-1: 設定読み取り・更新は /v1/admin/settings に委譲する。
- CC-MCP-CONFIG-2: 秘密値の読み取りは既存 API の set フラグのみ。更新値を独自にログへ書かない。
- CC-MCP-CONFIG-3: 未知キー・型不一致は既存 API が拒否する。成功を捏造しない。
- CC-MCP-CONFIG-4: チーム更新は指定したフィールドだけ送る。repos と settings は全置換なので最新一覧から既存分を保持する。同時更新を防ぐ CAS は既存 API に無く、更新後に読み直して結果を照合する。
- CC-MCP-CONFIG-5: 更新のタイムアウトは結果不明。読み取りで照合し、自動再試行しない。

concordia_get_settings / concordia_update_settings と concordia_list_teams /
concordia_update_team を既存 concordia-core MCP に追加する。
チーム更新は repositories、settings、rules_text が対象。所有子会社の変更は公開しない。
各設定の即時反映・再起動要否は API の定義に従い、MCP 呼び出しだけで再起動しない。
既存 loopback API の信頼境界を維持し、MCP 設定変更ツールはユーザーの依頼範囲で使う。

検証: ユーザー指示によりテスト・起動確認は実行しない。ビルドで型整合を確認する。
配布: Revisor local PR 経由。ビルド済み MCP が配置された後、新規 MCP 接続から利用可能。
復旧: 当該変更を戻し MCP を再接続する。設定変更の取消は対象キーの以前の値を API で明示更新する。
