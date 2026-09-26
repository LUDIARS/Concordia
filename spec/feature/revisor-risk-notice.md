# Rv高スコアsystem通知

契約: CC-RV-RISK-NOTICE-01。価値: UX-CC-PRODUCT（人間が判断すべき状態を取りこぼさない）。
失うと困る状態: 高スコアのマージや修正後も残るリスクを人間が認識できない。
状態所有者: Rvはスコア・再審査・通知受付状態、Ccは管理者メンション先とchat配送を所有する。
不変条件: メンション先はCc設定のみから解決し、本文やRv入力から任意IDを受け取らない。
API: POST /v1/chat のsystem通知でmention_admin=trueを許可する。管理者未設定は書込前に拒否する。
受付成功時はmention_admin_resolved=trueを返す。配送完了とは区別する。
境界: src/api/chat.ts と register-chat.ts。試験: src/api/chat.test.ts。

検証: 登録テスト chat/Discord egress 2件（内部23テスト）成功。runId r-20260926124624826-251231a8。型チェック成功。Anatomiaの対象コード差分は5ゲート成功。実Discord通知とサービス反映は未実施。復旧: 本契約の追加フィールドを送らない従来通知は変更しない。取り消す場合はRvからのmention_admin送信を止めてからCc側を戻す。
