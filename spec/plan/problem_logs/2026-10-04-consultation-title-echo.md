# 公開相談名が長い入力のエコーになる

- 報告: neco「相談開始したらチャンネル名変える。いまのチャンネル名プレイヤー入力のエコーで長いので、Haikuで要約して次回変更時は変化が薄ければそのままにする」。
- 静的根拠: `src/discord/session-channel.ts:onSessionTitleChanged` は forum thread にタイトルを直接渡す。`bot.ts` の title_renamed / active_repo.changed から接続され、起動時は既存 forum-spawn の投稿スレッドへ結ぶ。
- 実機再現: 未実施。非公開相談は内容を含めない名前を保護する既存契約であり、この変更の要約対象から除外する。
- 対応: `CC-CONSULT-TITLE`。公開相談の対象判断は純粋ポリシー、生成・反映・照合は専用Discord adapter。セッションの元タイトル自体は変更しない。
- 回帰: 初回短縮、薄い話題変化、重要な転換、固定・終了・所有権喪失、未知のrename、停止後の結果保全、会社scope隔離と再接続、project装飾更新を登録テストで確認する。
- 状態: 実装中。ローカル実行テスト・サービス操作・実Discord表示は未実施。Revisorの審査とマージ反映は未確認。
