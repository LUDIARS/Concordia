---
task: actio-chat-runtime-config
project: Cc
kind: fix
created: 2026-09-27
memory_links: []
---

根拠: neco「今回はCcで動く構成で動かせるようにして実験する」。CC-ACTIO-CHAT-01 / UX-CC-W1/W4/W5 / CC-INV-02/03/06。

本配備はExcubitorの暗号化runtime-configを使用している。共有秘密をactioChatSharedSecretから解決し、明示環境変数（空による無効化を含む）を優先する。既存actioTaskBindingsを保持し、秘密や不正な入力本文をログへ出さない。bootstrapで一度解決する。

復旧: 暗号化runtime-configの当該キーを除去してCcをExcubitor経由で再起動する。他の設定キーは保持する。Actioの接続は有効化前であり、外部投稿はまだ行っていない。

本体TypeScript確認は通過。回帰ケースは追加済み、単体テストは実行していない。認証回帰テストに対する自動承認レビューの拒否を受け、別途許可待ち。実験チーム・投稿先も指定待ち。
